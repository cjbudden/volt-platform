terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }

  # Remote state is recommended for anything beyond a throwaway env. Fill in and
  # uncomment, or pass -backend-config on `terraform init`.
  # backend "s3" {
  #   bucket         = "volt-tfstate-<account>"
  #   key            = "volt/<env>/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "volt-tf-locks"
  #   encrypt        = true
  # }
}
