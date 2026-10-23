terraform {
  required_version = "~> 1.10"

  # Pessimistic constraints: at least the current release, never a new major version (exact versions are
  # pinned in .terraform.lock.hcl).
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
    awscc = {
      source  = "hashicorp/awscc"
      version = "~> 1.107"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.8"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.9"
    }
  }
}

provider "aws" {}
provider "awscc" {}
