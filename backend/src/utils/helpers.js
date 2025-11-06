export function formatToWIB(utcTimestamp) {
  if (!utcTimestamp) return null;

  try {
    const date = new Date(utcTimestamp);
    const wibDate = new Date(date.getTime() + (7 * 60 * 60 * 1000));
    
    const year = wibDate.getUTCFullYear();
    const month = String(wibDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(wibDate.getUTCDate()).padStart(2, '0');
    const hours = String(wibDate.getUTCHours()).padStart(2, '0');
    const minutes = String(wibDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(wibDate.getUTCSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch (error) {
    return 'Invalid date';
  }
}

export function getNestedValue(obj, path) {
  const parts = path.split('.');
  let current = obj;
  
  for (const part of parts) {
    if (current && typeof current === 'object') {
      current = current[part];
    } else {
      return null;
    }
  }
  
  return current?._value || null;
}

export function cleanGenieACSData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => cleanGenieACSData(item));
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(data)) {
    if (['_object', '_writable', '_timestamp', '_type', '_instance'].includes(key)) {
      continue;
    }
    cleaned[key] = cleanGenieACSData(value);
  }

  return cleaned;
}

export function createResponse(success, message, data = null, statusCode = 200) {
  const response = {
    success,
    message
  };
  
  if (data !== null) {
    response.data = data;
  }
  
  return response;
}

export function createErrorResponse(message, error = null, statusCode = 500) {
  const response = {
    success: false,
    message
  };
  
  if (error) {
    response.error = error;
  }
  
  return response;
}

export function validateRequiredFields(obj, requiredFields) {
  const missingFields = [];
  
  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
      missingFields.push(field);
    }
  }
  
  return missingFields;
}

export function sanitizeInput(input) {
  if (typeof input !== 'string') {
    return input;
  }
  
  return input.trim();
}

export function parseJsonSafely(jsonString, defaultValue = null) {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error('Error parsing JSON:', error);
    return defaultValue;
  }
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function generateRandomId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function paginate(array, page = 1, limit = 10) {
  const startIndex = (page - 1) * limit;
  const endIndex = startIndex + limit;
  
  return {
    data: array.slice(startIndex, endIndex),
    pagination: {
      page,
      limit,
      total: array.length,
      totalPages: Math.ceil(array.length / limit)
    }
  };
}

export function calculateRxPowerDistribution(devices) {
  const rxPowerData = {
    excellent: 0,
    fair: 0,
    poor: 0,
    na: 0
  };
  
  devices.forEach(device => {
    if (!device.rxpower) {
      rxPowerData.na++;
    } else {
      const rxPower = parseFloat(device.rxpower);
      if (rxPower >= -21) {
        rxPowerData.excellent++;
      } else if (rxPower >= -25) {
        rxPowerData.fair++;
      } else {
        rxPowerData.poor++;
      }
    }
  });
  
  const totalDevices = rxPowerData.excellent + rxPowerData.fair + rxPowerData.poor + rxPowerData.na;
  
  return {
    labels: ["Excellent", "Fair", "Poor", "N/A"],
    series: [
      rxPowerData.excellent,
      rxPowerData.fair,
      rxPowerData.poor,
      rxPowerData.na
    ],
    colors: [
      '#10B981',
      '#FBBF24',
      '#EF4444',
      '#6B7280'
    ],
    totalDevices
  };
}