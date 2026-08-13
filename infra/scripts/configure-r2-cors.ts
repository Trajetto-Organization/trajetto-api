import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { env } from "@/env";
import { uploadConfig } from "@/config/upload";

/**
 * Applies the CORS rules the browser needs to PUT straight to R2.
 *
 * Direct upload moves the request out of the API and into the browser, which
 * means the bucket — not Fastify — is now the thing answering the preflight.
 * Without this the PUT fails before it leaves the tab, with no server log to
 * show for it.
 *
 * Idempotent: run it again after adding an origin.
 */
class R2CorsConfigurator {
  private client = new S3Client({
    credentials: {
      accessKeyId: uploadConfig.r2.accessKeyId,
      secretAccessKey: uploadConfig.r2.secretAccessKey,
    },
    endpoint: `https://${uploadConfig.r2.accountId}.r2.cloudflarestorage.com`,
    region: "auto",
  });

  /**
   * Only the origins that actually upload. The mobile app is not listed on
   * purpose: a native fetch is not subject to CORS, so adding it would widen
   * the bucket for nothing.
   */
  private get allowedOrigins(): string[] {
    const origins = [env.HTTP_REQUEST, env.API_HTTP_REQUEST];

    if (env.NODE_ENV !== "production") {
      origins.push("http://localhost:3000");
    }

    return [...new Set(origins.filter((origin): origin is string => !!origin))];
  }

  async run(): Promise<void> {
    if (uploadConfig.storage.type !== "r2") {
      console.log("⏭️  [R2 CORS] Storage is not R2, nothing to configure.");
      return;
    }

    const bucket = uploadConfig.r2.bucket;

    if (!bucket || !uploadConfig.r2.accountId) {
      throw new Error(
        "[R2 CORS] R2_BUCKET_NAME and R2_ACCOUNT_ID must be set to configure CORS.",
      );
    }

    const origins = this.allowedOrigins;

    console.log(`🔧 [R2 CORS] Bucket: ${bucket}`);
    console.log(`🔧 [R2 CORS] Origins: ${origins.join(", ")}`);

    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: origins,

              // PUT is the upload itself. HEAD/GET are here so a client can
              // read back a signed URL from the same origin without a second
              // rule; POST and DELETE are deliberately absent — the browser
              // never deletes, the API does.
              AllowedMethods: ["PUT", "GET", "HEAD"],

              // `content-type` is signed into the URL, so the browser sends it
              // and the preflight has to accept it. It is also what makes the
              // request non-simple in the first place.
              AllowedHeaders: ["content-type", "content-length"],

              // `etag` lets the client confirm what landed. Nothing else is
              // worth exposing to page scripts.
              ExposeHeaders: ["etag"],

              // The preflight result is cached for an hour, so a checklist
              // with twenty photos pays for it once instead of twenty times.
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );

    console.log("✅ [R2 CORS] Rules applied.");

    const current = await this.client.send(
      new GetBucketCorsCommand({ Bucket: bucket }),
    );

    console.log(
      "🔎 [R2 CORS] Bucket now reports:",
      JSON.stringify(current.CORSRules, null, 2),
    );
  }
}

new R2CorsConfigurator()
  .run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ [R2 CORS] Failed to configure CORS:", error);
    process.exit(1);
  });
