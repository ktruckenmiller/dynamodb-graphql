var ejs = require('ejs');
var AWS = require("aws-sdk");
var bluebird = require('bluebird');


AWS.config.region = process.env["aws-region"] || "us-east-1";

var cloudformation = new AWS.CloudFormation();

const data = `
---
AWSTemplateFormatVersion: 2010-09-09
Parameters:
  Environment:
    Type: String
    Default: dev
    AllowedValues:
      - dev
      - test
      - prod
    Description: The Name Of Your Environment
Resources:
  <% tables.forEach(function(table) { %><%= table %>Table:
    Type: "AWS::DynamoDB::Table"
    Properties:
      TableName: !Sub $\{Environment}-<%= project %>-<%= table %>s
      AttributeDefinitions:
        - AttributeName: id
          AttributeType: S
        - AttributeName: hash
          AttributeType: S
        - AttributeName: predicate
          AttributeType: S
        - AttributeName: value
          AttributeType: S
      KeySchema:
        - AttributeName: id
          KeyType: HASH
        - AttributeName: hash
          KeyType: RANGE
      ProvisionedThroughput:
        ReadCapacityUnits: "5"
        WriteCapacityUnits: "5"
      GlobalSecondaryIndexes:
      - IndexName: "predicate-index"
        KeySchema:
        - AttributeName: predicate
          KeyType: HASH
        Projection:
          ProjectionType: ALL
        ProvisionedThroughput:
          ReadCapacityUnits: "5"
          WriteCapacityUnits: "5"
      - IndexName: "value-index"
        KeySchema:
        - AttributeName: value
          KeyType: HASH
        Projection:
          ProjectionType: ALL
        ProvisionedThroughput:
          ReadCapacityUnits: "5"
          WriteCapacityUnits: "5"
  <% }); %>
  <%= project %>Role:
    Type: "AWS::IAM::Role"
    DependsOn:
    <% tables.forEach(function(table) { %>
    - <%= table %>Table
    <% }); %>
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
        - Effect: "Allow"
          Principal:
            Service: lambda.amazonaws.com
          Action:
          - "sts:AssumeRole"
      Path: '/'
      RoleName: !Sub $\{Environment}-<%= project %>-role
      Policies:
        - PolicyName: ddb
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
            - Effect: "Allow"
              Action:
              - "dynamodb:GetItem"
              - "dynamodb:GetRecords"
              - "dynamodb:BatchGetItem"
              - "dynamodb:BatchWriteItem"
              - "dynamodb:DeleteItem"
              - "dynamodb:PutItem"
              - "dynamodb:Query"
              - "dynamodb:Scan"
              - "dynamodb:UpdateItem"
              <% tables.forEach(function(table) { %>
              Resource: !Sub arn:aws:dynamodb:$\{AWS::Region}:$\{AWS::AccountId}:table/$\{<%= table %>Table}
              Resource: !Sub arn:aws:dynamodb:$\{AWS::Region}:$\{AWS::AccountId}:table/$\{<%= table %>Table}/index/*
              <% }); %>
        - PolicyName: lambda-execute
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
            - Effect: "Allow"
              Action:
              - "logs:*"
              Resource:
              - "arn:aws:logs:*:*:*"
            - Effect: "Allow"
              Action:
              - "s3:GetObject"
              - "s3:PutObject"
              Resource:
              - "arn:aws:s3:::*"
Outputs:
<% tables.forEach(function(table) { %>
  <%= table %>TableName:
    Description: Information about the value
    Value: !Ref <%= table %>Table
    Export:
      Name: <%= table %>TableName
<% }); %>
`;

var template = ejs.compile(data);

function generateCFN(project, tables) {
    return template({tables: tables, project: project});
}

function deployStack(project, stack, environment) {
    var stackName = environment + "-" + project;
    return new bluebird.Promise(function(resolve, reject) {
        cloudformation.describeStacks({StackName: stackName}).promise()
            .then(function(d) {
                // stack exists, let's update it
                var params = {
                    StackName: stackName,
                    Capabilities: ["CAPABILITY_NAMED_IAM"],
                    TemplateBody: stack,
                }
                cloudformation.updateStack(params).promise()
                    .then(function(d) {
                        var waiter = cloudformation.waitFor('stackUpdateComplete', {StackName: stackName}).promise();
                        waiter.then(function(d) {
                            getStackOutputs(stackName)
                                .then(function(d) {
                                      resolve(d);
                                })
                                .catch(function(err) {
                                   reject(err);
                                });
                            })
                        .catch(function(err) {
                            reject(err);
                        });
                    })
                    .catch(function(err) {
                        if(new RegExp("No updates").test(err.message)) {
                            getStackOutputs(stackName)
                                .then(function(d) {
                                    resolve(d);
                                })
                                .catch(function(err) {
                                    reject(err);
                                });
                        } else {
                            reject(err);
                        }
                    });
            })
            .catch(function(err) {
                // does not exist yet, let's create it
                var params = {
                    StackName: stackName,
                    Capabilities: ["CAPABILITY_NAMED_IAM"],
                    TemplateBody: stack,
                }
                cloudformation.createStack(params).promise()
                    .then(function(d) {
                        var waiter = cloudformation.waitFor('stackCreateComplete', {StackName: stackName}).promise();
                        waiter.then(function(d) {
                            getStackOutputs(stackName)
                                .then(function(d) {
                                      resolve(d);
                                })
                                .catch(function(err) {
                                   reject(err);
                                });
                            })
                        .catch(function(err) {
                            reject(err);
                        });
                    })
                    .catch(function(err) {
                        reject(err);
                    });
            });
    });
}

function getStackOutputs(stackName) {
    return new bluebird.Promise(function(resolve, reject) {
        cloudformation.describeStacks({StackName: stackName}).promise()
            .then(function(d) {
                // console.log(d);
                if(d.Stacks) {
                    var hash = {};
                    d.Stacks[0].Outputs.forEach(function(item) {
                        hash[item.ExportName] = item.OutputValue;
                    });
                    resolve(hash);
                } else {
                    reject({'message': 'stack not found'})
                }
            })
            .catch(function(err) {
                reject(err);
            });
    });
}

function deploy(project, tables, environment) {
    var stack = generateCFN(project, tables);
    return deployStack(project, stack, environment);
}

function deleteStack(project, environment) {
    var stackName = environment + "-" + project;
    return new bluebird.Promise(function(resolve, reject) {
        cloudformation.deleteStack({StackName: stackName}).promise()
            .then(function(d) {
                var waiter = cloudformation.waitFor('stackDeleteComplete', {StackName: stackName}).promise();
                    waiter.then(function(d) {
                        resolve(d);
                    })
                    .catch(function(err) {
                        reject(err);
                    });
            })
            .catch(function(err) {
                reject(err);
            });
    });
}


exports.generateCFN = generateCFN;
exports.deploy = deploy;
exports.deployStack = deployStack;
exports.deleteStack = deleteStack;
