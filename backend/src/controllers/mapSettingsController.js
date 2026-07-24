import MapSettings from '../models/MapSettings.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

class MapSettingsController {
  static async getMapSettings(req, res) {
    try {
      const settings = await MapSettings.get();
      
      if (!settings) {
        return res.json(
          createResponse('Map settings retrieved successfully', {
            center_lat: '-6.2088',
            center_lng: '106.8456',
            max_zoom_in: '18',
            max_zoom_out: '5',
            default_zoom: '13'
          })
        );
      }
      
      return res.json(
        createResponse('Map settings retrieved successfully', settings)
      );
    } catch (error) {
      console.error('Get map settings error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to get map settings', error.message)
      );
    }
  }

  static async updateMapSettings(req, res) {
    try {
      const { center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom } = req.body;
      
      if ([center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom]
        .some((value) => value === undefined || value === null || value === '')) {
        return res.status(400).json(
          createErrorResponse('All fields are required: center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom')
        );
      }

      const lat = Number(center_lat);
      const lng = Number(center_lng);
      const maxIn = Number(max_zoom_in);
      const maxOut = Number(max_zoom_out);
      const defaultLevel = Number(default_zoom);

      if (
        !Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lng) || lng < -180 || lng > 180 ||
        !Number.isInteger(maxIn) || maxIn < 1 || maxIn > 22 ||
        !Number.isInteger(maxOut) || maxOut < 1 || maxOut > 22 ||
        !Number.isInteger(defaultLevel) ||
        defaultLevel < maxOut || defaultLevel > maxIn ||
        maxOut > maxIn
      ) {
        return res.status(400).json(
          createErrorResponse('Invalid coordinates or zoom levels')
        );
      }

      await MapSettings.upsert({
        center_lat: String(lat),
        center_lng: String(lng),
        max_zoom_in: String(maxIn),
        max_zoom_out: String(maxOut),
        default_zoom: String(defaultLevel)
      });
      
      const updatedSettings = await MapSettings.get();
      
      return res.json(
        createResponse('Map settings updated successfully', updatedSettings)
      );
    } catch (error) {
      console.error('Update map settings error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update map settings', error.message)
      );
    }
  }

  static async resetMapSettings(req, res) {
    try {
      await MapSettings.reset();
      
      const resetSettings = await MapSettings.get();
      
      return res.json(
        createResponse('Map settings reset to defaults', resetSettings)
      );
    } catch (error) {
      console.error('Reset map settings error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to reset map settings', error.message)
      );
    }
  }
}

export default MapSettingsController;
