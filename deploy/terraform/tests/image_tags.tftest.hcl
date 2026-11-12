# Image tags name a release, never latest (build queue D1, variables.tf), and
# the per-stream images follow the control plane's tag unless set apart.
# Planned against mocked providers:  terraform init -backend=false && terraform test
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_subnet" {
    defaults = { arn = "arn:aws:ec2:eu-west-1:111122223333:subnet/subnet-1" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/x" }
  }
}
mock_provider "aws" {
  alias = "us_east_1"
}
# The second region for the dr tier's snapshot copies (resilience.tf).
mock_provider "aws" {
  alias = "backup_copy"
}
mock_provider "random" {}


# The image names themselves are unknown at plan (the repository URLs), so the
# tags are read from the image_tags output.
run "release_tag_everywhere" {
  command = plan
  variables {
    control_plane_image_tag = "v0.43.0-1a2b3c4"
  }
  assert {
    condition     = output.image_tags.control_plane == "v0.43.0-1a2b3c4" && output.image_tags.encoders == "v0.43.0-1a2b3c4"
    error_message = "encoder images do not follow the control plane's release tag"
  }
}

run "encoder_tag_apart" {
  command = plan
  variables {
    control_plane_image_tag = "v0.43.0-1a2b3c4"
    encoder_image_tag       = "v0.42.0"
  }
  assert {
    condition     = output.image_tags.encoders == "v0.42.0"
    error_message = "encoder_image_tag is not used"
  }
}

run "latest_refused" {
  command = plan
  variables {
    control_plane_image_tag = "latest"
  }
  expect_failures = [var.control_plane_image_tag]
}

run "latest_refused_for_encoders" {
  command = plan
  variables {
    control_plane_image_tag = "v0.43.0"
    encoder_image_tag       = "latest"
  }
  expect_failures = [var.encoder_image_tag]
}
