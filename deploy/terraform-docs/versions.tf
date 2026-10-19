# The customer docs site, as its OWN stack with its OWN state.
#
# Why separate from deploy/terraform (the platform): the docs are a static site
# with a different change rate and no runtime. Keeping them apart means a docs
# change can never plan a change to the platform, and the platform can be
# rebuilt without touching the docs. The platform stack only needs this stack's
# outputs (see outputs.tf) to issue the sign-in cookie.
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40.0" }
    tls = { source = "hashicorp/tls", version = ">= 4.0.0" }
  }
  # Use a remote, encrypted backend: the docs signing key is in this state.
  # backend "s3" {
  #   bucket  = "volt-tfstate-<account>"
  #   key     = "volt/<env>/docs.tfstate"
  #   region  = "ap-southeast-2"
  #   encrypt = true
  # }
}
