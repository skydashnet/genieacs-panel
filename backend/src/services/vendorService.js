import Vendor from '../models/Vendor.js';

class VendorService {
  static async detectVendor(manufacturer, productClass, deviceData = null) {
    const vendors = await Vendor.getEnabled();

    if (deviceData) {
      const matchingVendors = [];
      
      for (const vendor of vendors) {
        if (manufacturer) {
          const manufacturerLower = manufacturer.toLowerCase();
          const matchesManufacturer = vendor.manufacturer_patterns.some(pattern => 
            manufacturerLower.includes(pattern.toLowerCase())
          );
          
          if (matchesManufacturer) {
            if (vendor.product_patterns.length > 0 && productClass) {
              const productClassLower = productClass.toLowerCase();
              const matchesProduct = vendor.product_patterns.some(pattern =>
                productClassLower.includes(pattern.toLowerCase())
              );
             
              if (matchesProduct) {
                matchingVendors.push(vendor);
              }
            } else if (vendor.product_patterns.length === 0) {
              matchingVendors.push(vendor);
            }
          }
        }
      }
      
      if (matchingVendors.length > 1) {
        for (const vendor of matchingVendors) {
          if (vendor.parameter_prefix && this.hasVendorPrefix(deviceData, vendor.parameter_prefix)) {
            return vendor;
          }
        }
      } else if (matchingVendors.length === 1) {
        return matchingVendors[0];
      }
    }

    for (const vendor of vendors) {
      if (manufacturer) {
        const manufacturerLower = manufacturer.toLowerCase();
        const matchesManufacturer = vendor.manufacturer_patterns.some(pattern => 
          manufacturerLower.includes(pattern.toLowerCase())
        );
        
        if (matchesManufacturer) {
          if (vendor.product_patterns.length > 0 && productClass) {
            const productClassLower = productClass.toLowerCase();
            const matchesProduct = vendor.product_patterns.some(pattern =>
              productClassLower.includes(pattern.toLowerCase())
            );
           
            if (matchesProduct) {
              return vendor;
            }
          } else {
            return vendor;
          }
        }
      }

      if (productClass) {
        const productClassLower = productClass.toLowerCase();
        const matchesProduct = vendor.product_patterns.some(pattern =>
          productClassLower.includes(pattern.toLowerCase())
        );

        if (matchesProduct) {
          return vendor;
        }
      }
    }

    return null;
  }

  static hasVendorPrefix(deviceData, prefix) {
    if (!deviceData || !prefix) return false;
    
    const igdData = deviceData.InternetGatewayDevice;
    if (!igdData) return false;
    
    if (igdData[prefix]) {
      return true;
    }
    
    const wanDevices = igdData.WANDevice;
    if (wanDevices) {
      for (const wanKey in wanDevices) {
        const wanDevice = wanDevices[wanKey];
        if (wanDevice && wanDevice.WANConnectionDevice) {
          for (const connKey in wanDevice.WANConnectionDevice) {
            const connDevice = wanDevice.WANConnectionDevice[connKey];
            
            if (connDevice && connDevice[prefix]) {
              return true;
            }
            
            if (connDevice && connDevice.WANIPConnection) {
              for (const ipKey in connDevice.WANIPConnection) {
                const ipConn = connDevice.WANIPConnection[ipKey];
                if (ipConn && ipConn[prefix]) {
                  return true;
                }
              }
            }
            
            if (connDevice && connDevice.WANPPPConnection) {
              for (const pppKey in connDevice.WANPPPConnection) {
                const pppConn = connDevice.WANPPPConnection[pppKey];
                if (pppConn && pppConn[prefix]) {
                  return true;
                }
              }
            }
          }
        }
      }
    }
    
    return false;
  }
}

export default VendorService;
