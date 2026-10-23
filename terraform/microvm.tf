# The Doom MicroVM image: Lambda builds it from a zip of doom/ (Dockerfile + sources), runs it until the /ready
# hook says yes (Doom running, encoder warm), and snapshots it. MicroVMs are started from it at run time by the
# webui (RunMicrovm), not by Terraform.

locals {
  image_name     = local.project_name
  doom_dir       = abspath("${path.module}/../doom")
  log_group_name = "/aws/lambda-microvms/${local.image_name}"
  log_group_arn  = "arn:aws:logs:${local.region}:${local.account_id}:log-group:${local.log_group_name}:*"
}

# --- Code artifact: zip of doom/ in S3 ---

resource "aws_s3_bucket" "artifacts" {
  bucket        = "${local.project_name}-artifacts-${local.account_id}"
  force_destroy = true
}

data "archive_file" "doom" {
  type        = "zip"
  source_dir  = local.doom_dir
  excludes    = ["server/node_modules/**", "engine/build/**", "engine/doomgeneric_headless", "**/.DS_Store", ".DS_Store"]
  output_path = "${path.module}/.build/doom.zip"
}

# Keyed by content, so a code change is a new artifact (and a new image build).
resource "aws_s3_object" "doom" {
  bucket      = aws_s3_bucket.artifacts.id
  key         = "doom/${data.archive_file.doom.output_md5}.zip"
  source      = data.archive_file.doom.output_path
  source_hash = data.archive_file.doom.output_md5
}

# --- Build role: reads the artifact, writes build logs ---

resource "aws_iam_role" "microvm_build" {
  name = "${local.image_name}-microvm-build"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "microvm_build" {
  name = "microvm-build"
  role = aws_iam_role.microvm_build.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.artifacts.arn}/doom/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = local.log_group_arn
      },
    ]
  })
}

# --- The image ---

# Declared through CloudFormation (AWS::Lambda::MicrovmImage) rather than awscc_lambda_microvm_image: the schema
# requires AdditionalOsCapabilities, EgressNetworkConnectors and EnvironmentVariables, and awscc drops empty sets
# from the request, so Cloud Control rejects it ("required key [...] not found"). Here `[]` is sent as written.
resource "aws_cloudformation_stack" "microvm_image" {
  name = local.image_name

  template_body = jsonencode({
    Resources = {
      MicrovmImage = {
        Type = "AWS::Lambda::MicrovmImage"
        Properties = {
          Name              = local.image_name
          Description       = "Doom (doomgeneric + Freedoom) streaming frames over a WebSocket"
          BaseImageArn      = "arn:aws:lambda:${local.region}:aws:microvm-image:al2023-1"
          BaseImageVersion  = "1"
          BuildRoleArn      = aws_iam_role.microvm_build.arn
          CodeArtifact      = { Uri = "s3://${aws_s3_bucket.artifacts.id}/${aws_s3_object.doom.key}" }
          CpuConfigurations = [{ Architecture = "ARM_64" }]

          Resources = [{ MinimumMemoryInMiB = 2048 }]

          # Required by the schema; empty = no extras.
          AdditionalOsCapabilities = []
          EgressNetworkConnectors  = []
          EnvironmentVariables     = []

          Hooks = {
            # Hook listener port. The game listens on 8081 and is reached via X-aws-proxy-port (an auth-token concern).
            Port = 8080
            MicrovmImageHooks = {
              # /ready: 200 once Doom has drawn a frame and the WebP encoder is warm (both land in the snapshot).
              Ready                 = "ENABLED"
              ReadyTimeoutInSeconds = 300
              # /validate: reads node, sharp's libvips, the engine, the WAD and the music MP3s so starts prefetch them.
              Validate                 = "ENABLED"
              ValidateTimeoutInSeconds = 120
            }
            # /run only records the MicroVM id; the game is already running from the snapshot.
            MicrovmHooks = { Run = "ENABLED", RunTimeoutInSeconds = 15 }
          }

          Logging = {
            CloudWatch = { LogGroup = local.log_group_name }
          }
        }
      }
    }

    Outputs = {
      ImageArn = { Value = { "Fn::GetAtt" = ["MicrovmImage", "ImageArn"] } }
    }
  })

  # The image build (apt, engine compile, music render, snapshot) can outlast the 30 min default.
  timeouts {
    create = "60m"
    update = "60m"
  }

  # The build reads the artifact with the build role, so its policy must exist first.
  depends_on = [aws_iam_role_policy.microvm_build]
}

# --- Run role: what a running MicroVM may do (write its logs only) ---

resource "aws_iam_role" "microvm_run" {
  name = "${local.image_name}-microvm-run"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role_policy" "microvm_run" {
  name = "microvm-run"
  role = aws_iam_role.microvm_run.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = local.log_group_arn
    }]
  })
}

# For running the webui locally against AWS (make webui-run-aws).
resource "local_file" "microvm_image_arn" {
  filename        = "${path.module}/../tmp/microvm_image_arn.txt"
  content         = "${aws_cloudformation_stack.microvm_image.outputs["ImageArn"]}\n"
  file_permission = "0644"
}

resource "local_file" "microvm_run_role_arn" {
  filename        = "${path.module}/../tmp/microvm_run_role_arn.txt"
  content         = "${aws_iam_role.microvm_run.arn}\n"
  file_permission = "0644"
}

output "microvm_image_arn" {
  value = aws_cloudformation_stack.microvm_image.outputs["ImageArn"]
}
