provider "aws" {
  region = var.region

  default_tags {
    tags = merge({
      Project   = var.project
      Env       = var.env
      ManagedBy = "terraform"
      Product   = "Volt Streaming"
    }, var.tags)
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "${var.project}-${var.env}"
  azs  = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}
