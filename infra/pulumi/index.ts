import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { createUploadsBucket, createS3User } from "./resources";

// Get project configuration
const projectName = "trajetto";
const environment = pulumi.getStack();

// Create S3 infrastructure for file uploads
const s3Infrastructure = createUploadsBucket({
  projectName,
  environment,
});

// Create IAM user for S3 access
const iamInfrastructure = createS3User({
  projectName,
  environment,
  bucketName: s3Infrastructure.bucket.bucket,
});

// Export important values for application configuration
export const bucketName = s3Infrastructure.bucket.bucket;
export const bucketArn = s3Infrastructure.bucket.arn;

export const bucketDomainName = s3Infrastructure.bucket.bucketDomainName;
export const bucketUrl = pulumi.interpolate`https://${s3Infrastructure.bucket.bucket}.s3.amazonaws.com`;

export const s3AccessKeyId = iamInfrastructure.accessKey.id;
export const s3SecretAccessKey = iamInfrastructure.accessKey.secret;

export const awsRegion = aws.config.region || "us-east-1";

// Export resource references for advanced usage
export const resources = {
  storage: s3Infrastructure,
  iam: iamInfrastructure,
};
