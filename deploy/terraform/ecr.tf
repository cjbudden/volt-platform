# Container registries for the images the platform ships. Radio and captions
# are their own images (volt-encoder/Dockerfile.radio and Dockerfile.captions):
# a station needs ffmpeg alone, and the captions models and CUDA stay out of the
# encoder so every channel does not pay to pull them.
locals {
  ecr_repos = ["volt-control-plane", "volt-encoder", "volt-thumbnailer", "volt-fast", "volt-radio", "volt-captions"]
}

resource "aws_ecr_repository" "repo" {
  for_each             = toset(local.ecr_repos)
  name                 = each.value
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
  tags = { Name = each.value }
}

# Keep only the last 20 images per repo.
resource "aws_ecr_lifecycle_policy" "repo" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 20"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}
