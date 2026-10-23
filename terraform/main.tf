data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  project_name = "lambda-microvm-doom"
  region       = data.aws_region.current.region
  account_id   = data.aws_caller_identity.current.account_id
}
