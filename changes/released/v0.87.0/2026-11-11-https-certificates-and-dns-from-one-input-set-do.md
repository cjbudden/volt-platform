---
scope: internal
type: added
area: Deploy
---
HTTPS, certificates and DNS from one input: set domain_name (and route53_zone_id when Route 53 hosts it) and Terraform makes api., cdn., img. and origin.<domain>, DNS-validated certificates for CloudFront and the ALB, an HTTPS listener with port 80 redirecting, HTTPS from CloudFront and the encoders to the ALB, and the DNS records (or lists them to create by hand). With no domain the stack is unchanged (deploy/terraform/dns_https.tf, APPLY.md step 3).
