terraform {
  required_version = ">= 1.10"

  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }

  backend "s3" {
    bucket       = "lab09-mikhunawasi--bucket"
    key          = "lab09/dev/terraform.tfstate"
    region       = "us-east-2"
    use_lockfile = true
  }
}