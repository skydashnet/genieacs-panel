import type { TranslationKey } from '@/lib/i18n'

/**
 * Os parâmetros virtuais TR-069 que o painel lê do GenieACS, com os caminhos
 * que o instalador (skydashnet/genieacs-installer) cria.
 *
 * Módulo próprio porque duas telas os editam: a Configuração, na self-hosted,
 * e o console da plataforma, na SaaS — onde o ACS é da plataforma e os
 * parâmetros dependem dos scripts que ela instalou nele.
 */
export const INSTALLER_VIRTUAL_PARAMETERS = {
  vpPppoeUsername: 'VirtualParameters.PPPUsername',
  vpWanBridge: 'VirtualParameters.WANBridge',
  vpRxPower: 'VirtualParameters.OpticalRXPower',
  vpTemperature: 'VirtualParameters.OpticalTemperature',
  vpActiveDevices: 'VirtualParameters.TotalStations',
  vpSuperAdmin: 'VirtualParameters.LoginSuperUser',
  vpSuperPassword: 'VirtualParameters.LoginSuperPass',
  vpUserAdmin: '',
  vpUserPassword: ''
}

/** `hintKey` is set for the fields the installer does not provide; the others show the raw parameter name. */
export const VIRTUAL_PARAMETER_FIELDS: {
  key: keyof typeof INSTALLER_VIRTUAL_PARAMETERS
  labelKey: TranslationKey
  parameterName?: string
  hintKey?: TranslationKey
}[] = [
  { key: 'vpPppoeUsername', labelKey: 'settings.vp.pppoeUsername', parameterName: 'PPPUsername' },
  { key: 'vpWanBridge', labelKey: 'settings.vp.wanBridge', parameterName: 'WANBridge' },
  { key: 'vpRxPower', labelKey: 'settings.vp.rxPower', parameterName: 'OpticalRXPower' },
  { key: 'vpTemperature', labelKey: 'settings.vp.temperature', parameterName: 'OpticalTemperature' },
  { key: 'vpActiveDevices', labelKey: 'settings.vp.activeDevices', parameterName: 'TotalStations' },
  { key: 'vpSuperAdmin', labelKey: 'settings.vp.superAdmin', parameterName: 'LoginSuperUser' },
  { key: 'vpSuperPassword', labelKey: 'settings.vp.superPassword', parameterName: 'LoginSuperPass' },
  { key: 'vpUserAdmin', labelKey: 'settings.vp.userAdmin', hintKey: 'settings.vp.optionalHint' },
  { key: 'vpUserPassword', labelKey: 'settings.vp.userPassword', hintKey: 'settings.vp.optionalHint' }
]

export type VirtualParameterKey = keyof typeof INSTALLER_VIRTUAL_PARAMETERS
