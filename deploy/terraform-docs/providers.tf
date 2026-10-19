provider "aws" {
  region = var.region
  default_tags {
    tags = merge({ Project = var.project, Env = var.env, ManagedBy = "terraform", Product = "Volt Streaming", Component = "docs" }, var.tags)
  }
}

locals {
  name = "${var.project}-${var.env}-docs"
}
