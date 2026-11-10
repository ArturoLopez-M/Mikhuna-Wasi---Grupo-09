provider "aws" {
  region = "us-east-2"
}

variable "frontend_bucket" {
  type    = string
  default = "mikhuna-front-arturolopez"
}

# --- S3 Frontend ---
resource "aws_s3_bucket" "frontend" {
  bucket        = var.frontend_bucket
  force_destroy = true
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.frontend.id
  key          = "index.html"
  content      = "<h1>Mikhuna Wasi</h1>"
  content_type = "text/html"
}

# --- Lambda ---
data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/lambda/index.mjs"
  output_path = "${path.module}/lambda.zip"
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/mikhuna-health"
  retention_in_days = 7
}

resource "aws_lambda_function" "health" {
  function_name    = "mikhuna-health"
  role             = "arn:aws:iam::357059693395:role/lab09-lambda-execution-role"
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  depends_on       = [aws_cloudwatch_log_group.lambda]
}

# --- API Gateway ---
resource "aws_apigatewayv2_api" "api" {
  name          = "mikhuna-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "health" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.health.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.health.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.health.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}