export function createResponse(message, data = null) {
  const response = {
    success: true,
    message
  };
  if (data !== null) {
    response.data = data;
  }
  return response;
}

export function createErrorResponse(message, error = null) {
  const response = {
    success: false,
    message
  };
  if (error) {
    response.error = error;
  }
  return response;
}
