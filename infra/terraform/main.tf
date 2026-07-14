# Base infrastructure (instructions.md §22.1): VPC, managed K8s, KMS, S3, DNS.
# Managed everywhere possible (§24.5): time goes to product logic, not failovers.
terraform {
  required_version = ">= 1.6"
  required_providers { aws = { source = "hashicorp/aws" } }
  backend "s3" { key = "axone/terraform.tfstate" } # remote, locked state
}

variable "region"      {
  type    = string
  default = "eu-west-1"
} # EU for export clients (§E.5)
variable "cluster_name" {
  type    = string
  default = "axone-prod"
}

module "vpc"     { source = "terraform-aws-modules/vpc/aws" }
module "eks"     { source = "terraform-aws-modules/eks/aws" } # managed K8s
# Dedicated, tainted node pool for sandboxes (gVisor RuntimeClass, §22.1).
# resource "aws_kms_key" "vault"  {}   # envelope encryption for oauth_tokens (§16.1)
# resource "aws_s3_bucket" "audit" {}  # WORM object-lock for audit export (§15.7)
