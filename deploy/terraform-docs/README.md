# Docs stack

The customer docs site's hosting, separate from the platform stack on purpose:
its own state, its own lifecycle, nothing shared at runtime. Private S3 bucket
(versioned, encrypted, CloudFront-only), a CloudFront distribution that admits
only requests carrying a Volt-signed cookie, the key that signs them (private
half in Secrets Manager for the platform), and a narrow IAM policy for whoever
publishes.

Setup, publishing, access and key rotation: [docs-site/MAINTAINING.md](../../docs-site/MAINTAINING.md).

```bash
cp terraform.tfvars.example terraform.tfvars   # fill in
terraform init && terraform apply
terraform output                                # docs_* values for deploy/terraform
```

The state holds the signing key: use the encrypted S3 backend in `versions.tf`.
