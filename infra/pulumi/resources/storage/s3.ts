import * as aws from "@pulumi/aws";

export interface S3BucketArgs {
  projectName: string;
  environment: string;
}

export interface S3BucketResult {
  bucket: aws.s3.Bucket;
  bucketPolicy: aws.s3.BucketPolicy;
  publicAccessBlock: aws.s3.BucketPublicAccessBlock;
}

export function createUploadsBucket(args: S3BucketArgs): S3BucketResult {
  const { projectName, environment } = args;

  // Create S3 bucket for file uploads
  const bucket = new aws.s3.Bucket(`${projectName}-uploads-${environment}`, {
    bucket: `${projectName}-uploads-${environment}`,
    // Enable versioning for better file management
    versioning: {
      enabled: true,
    },
    tags: {
      Name: `${projectName}-uploads-bucket`,
      Environment: environment,
      Purpose: "File uploads storage",
      Project: projectName,
    },
  });

  // Allow public read access for uploaded files (needed for public URLs)
  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
    `${projectName}-uploads-pab-${environment}`,
    {
      bucket: bucket.id,
      blockPublicAcls: false,
      blockPublicPolicy: false,
      ignorePublicAcls: false,
      restrictPublicBuckets: false,
    },
  );

  // Create bucket policy for public read access
  const bucketPolicy = new aws.s3.BucketPolicy(
    `${projectName}-uploads-bucket-policy-${environment}`,
    {
      bucket: bucket.id,
      policy: bucket.bucket.apply((bucketName) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "PublicReadGetObject",
              Effect: "Allow",
              Principal: "*",
              Action: "s3:GetObject",
              Resource: `arn:aws:s3:::${bucketName}/*`,
            },
          ],
        }),
      ),
    },
    { dependsOn: [publicAccessBlock] },
  );

  return {
    bucket,
    bucketPolicy,
    publicAccessBlock,
  };
}
