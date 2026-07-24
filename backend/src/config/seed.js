import { getDb } from './database.js';

export const DEFAULT_SETTINGS = {
  appName: 'SkyGenPanel',
  genieAcsUrl: '',
  vpPppoeUsername: 'VirtualParameters.PPPUsername',
  vpWanBridge: 'VirtualParameters.WANBridge',
  vpRxPower: 'VirtualParameters.OpticalRXPower',
  vpTemperature: 'VirtualParameters.OpticalTemperature',
  vpActiveDevices: 'VirtualParameters.TotalStations',
  vpSuperAdmin: 'VirtualParameters.LoginSuperUser',
  vpSuperPassword: 'VirtualParameters.LoginSuperPass',
  vpUserAdmin: '',
  vpUserPassword: ''
};

// Values shipped by older SkyGenPanel releases. Only these exact values are
// migrated, so an operator's custom mappings are never overwritten.
export const LEGACY_DEFAULT_SETTINGS = {
  appName: 'GenieACS Panel',
  vpPppoeUsername: 'VirtualParameters.pppoeUsername',
  vpWanBridge: 'VirtualParameters.WANBRIDGE',
  vpRxPower: 'VirtualParameters.RXPower',
  vpTemperature: 'VirtualParameters.gettemp',
  vpActiveDevices: 'VirtualParameters.activedevices',
  vpSuperAdmin: 'VirtualParameters.superAdmin',
  vpSuperPassword: 'VirtualParameters.superPassword',
  vpUserAdmin: 'VirtualParameters.userAdmin',
  vpUserPassword: 'VirtualParameters.userPassword'
};

export async function seedDefaults(db = getDb()) {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = await db('settings').where({ key }).first();
    if (!existing) {
      await db('settings').insert({ key, value });
    } else if (
      Object.hasOwn(LEGACY_DEFAULT_SETTINGS, key) &&
      existing.value === LEGACY_DEFAULT_SETTINGS[key]
    ) {
      await db('settings')
        .where({ key })
        .update({ value, updated_at: new Date() });
    }
  }

  const map = await db('map_settings').where({ id: 1 }).first();
  if (!map) {
    await db('map_settings').insert({
      id: 1,
      center_lat: '-6.2088',
      center_lng: '106.8456',
      max_zoom_in: '18',
      max_zoom_out: '5',
      default_zoom: '13'
    });
  }
}
