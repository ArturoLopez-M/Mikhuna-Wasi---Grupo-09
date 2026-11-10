output "health_url" {
  value = "${aws_apigatewayv2_api.api.api_endpoint}/health"
}