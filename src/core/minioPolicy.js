const ROLES = new Set(["owner", "writer", "reader"]);

// This policy is intentionally narrower than the client-side rclone safety plan.
// MinIO remains the final authority when a local job is tampered with.
export function buildMinioPrefixPolicy(input = {}) {
  const bucket = normalizeBucket(input.bucket);
  const prefix = normalizePrefix(input.prefix);
  const role = normalizeRole(input.role);
  const allowDelete = input.allowDelete === true && (role === "owner" || role === "writer");
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const objectArn = `${bucketArn}/${prefix}/*`;
  const readActions = ["s3:GetObject"];
  const writeActions = role === "reader"
    ? []
    : ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"];
  if (allowDelete) {
    writeActions.push("s3:DeleteObject");
  }

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [bucketArn],
        Condition: {
          StringLike: {
            "s3:prefix": [prefix, `${prefix}/*`]
          }
        }
      },
      {
        Effect: "Allow",
        Action: [...readActions, ...writeActions],
        Resource: [objectArn]
      }
    ]
  };
}

export function buildMinioPolicyName(input = {}) {
  const syncSpaceId = String(input.syncSpaceId || "").trim();
  const role = normalizeRole(input.role);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(syncSpaceId)) {
    throw new Error("syncSpaceId must be a valid identifier");
  }
  return `sfsc-${syncSpaceId}-${role}`.slice(0, 128);
}

function normalizeBucket(value) {
  const bucket = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("bucket must be a valid S3 bucket name");
  }
  return bucket;
}

function normalizePrefix(value) {
  const prefix = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("prefix must be a non-empty relative object prefix");
  }
  return prefix;
}

function normalizeRole(value) {
  if (!ROLES.has(value)) {
    throw new Error("role must be owner, writer, or reader");
  }
  return value;
}
