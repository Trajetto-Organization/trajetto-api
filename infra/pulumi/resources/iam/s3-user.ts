import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface S3UserArgs {
  projectName: string;
  environment: string;
  bucketName: pulumi.Output<string>;
}

export interface S3UserResult {
  user: aws.iam.User;
  accessKey: aws.iam.AccessKey;
  policy: aws.iam.Policy;
  policyAttachment: aws.iam.UserPolicyAttachment;
}

export function createS3User(args: S3UserArgs): S3UserResult {
  const { projectName, environment, bucketName } = args;

  // Create IAM user for application to access S3
  const user = new aws.iam.User(`${projectName}-s3-user-${environment}`, {
    name: `${projectName}-s3-user-${environment}`,
    tags: {
      Name: `${projectName}-s3-user`,
      Environment: environment,
      Purpose: "S3 access for application",
      Project: projectName,
    },
  });

  // Create access key for the user
  const accessKey = new aws.iam.AccessKey(
    `${projectName}-s3-access-key-${environment}`,
    {
      user: user.name,
    },
  );

  // Create IAM policy for S3 access
  const policy = new aws.iam.Policy(`${projectName}-s3-policy-${environment}`, {
    name: `${projectName}-s3-policy-${environment}`,
    description: "Policy for S3 uploads bucket access",
    policy: bucketName.apply((bucket) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "s3:GetObject",
              "s3:PutObject",
              "s3:DeleteObject",
              "s3:PutObjectAcl",
            ],
            Resource: `arn:aws:s3:::${bucket}/*`,
          },
          {
            Effect: "Allow",
            Action: ["s3:ListBucket", "s3:GetBucketLocation"],
            Resource: `arn:aws:s3:::${bucket}`,
          },
        ],
      }),
    ),
  });

  // Attach policy to user
  const policyAttachment = new aws.iam.UserPolicyAttachment(
    `${projectName}-s3-policy-attachment-${environment}`,
    {
      user: user.name,
      policyArn: policy.arn,
    },
  );

  return {
    user,
    accessKey,
    policy,
    policyAttachment,
  };
}
