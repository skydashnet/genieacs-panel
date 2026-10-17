import MapSettings, { DEFAULTS as MAP_DEFAULTS } from '../models/MapSettings.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

class MapSettingsController {
  static async getMapSettings(req, res) {
    try {
      const settings = await MapSettings.get();
      
      if (!settings) {
        return res.json(
          createResponse(req.t('mapSettings.retrieved'), { ...MAP_DEFAULTS })
        );
      }
      
      return res.json(
        createResponse(req.t('mapSettings.retrieved'), settings)
      );
    } catch (error) {
      console.error('Get map settings error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapSettings.getFailed'), error.message)
      );
    }
  }

  static async updateMapSettings(req, res) {
    try {
      const { center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom } = req.body;
      
      if ([center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom]
        .some((value) => value === undefined || value === null || value === '')) {
        return res.status(400).json(
          createErrorResponse(req.t('mapSettings.fieldsRequired'))
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
          createErrorResponse(req.t('mapSettings.invalidValues'))
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
        createResponse(req.t('mapSettings.updated'), updatedSettings)
      );
    } catch (error) {
      console.error('Update map settings error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapSettings.updateFailed'), error.message)
      );
    }
  }

  static async resetMapSettings(req, res) {
    try {
      await MapSettings.reset();
      
      const resetSettings = await MapSettings.get();
      
      return res.json(
        createResponse(req.t('mapSettings.reset'), resetSettings)
      );
    } catch (error) {
      console.error('Reset map settings error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('mapSettings.resetFailed'), error.message)
      );
    }
  }
}

export default MapSettingsController;
