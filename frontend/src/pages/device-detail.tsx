'use client'

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useToast } from '@/components/ui/toast'
import { DeviceParametersCard } from '@/components/device-parameters-card'
import { useLoading } from '@/components/ui/loading'
import { devicesAPI, sgpAPI, whatsappAPI, type SgpContractLink, type SgpInvoice } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { copyToClipboard, formatBrl, isSafeExternalUrl, sgpBadge } from '@/lib/sgp'
import { Icon } from '@/components/ui/icon'
import { ProvisioningCard } from '@/components/provisioning-card'
import { informedRecently, serialMatches, summonDeferredMessage } from '@/lib/device-actions'
import { DeviceHistoryCard } from '@/components/device-history-card'
import { DeviceSwapsCard } from '@/components/device-swaps-card'
import { DeviceDiagnosticsCard } from '@/components/device-diagnostics-card'
import { DeviceFirmwareCard } from '@/components/device-firmware-card'
import { useAuth } from '@/contexts/auth-context'
import { sessionOwner } from '@/lib/session-owner'
import { CustomerLgpd } from '@/components/customer-lgpd'
import { WifiStatusFilterControl } from '@/components/wifi-status-filter'
import { filterWifiByStatus, type WifiStatusFilter } from '@/lib/wifi-filter'
import { FilterRail, useStoredChoice } from '@/components/ui/filter-rail'
import { filterInvoicesByStatus, parseInvoiceStatusFilter, type InvoiceStatusFilter } from '@/lib/invoice-filter'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { RX_BAND_STYLE, rxBand } from '@/lib/rx-signal'

/* Linha rótulo/valor dos cartões: no celular o valor (ID, série, usuário
   PPPoE) quebra dentro da coluna em vez de empurrar a página para o lado. */
const KV_ROW = 'flex justify-between gap-4 *:first:shrink-0 *:last:min-w-0 *:last:text-end *:last:wrap-anywhere'

interface WanBindingData {
  lan: string[];
  ssid: string[];
}

interface WanConnection {
  index: string;
  connType: string;
  name?: string;
  status?: string;
  ipAddress?: string;
  macAddress?: string;
  vlanId?: any;
  username?: string;
  serviceList?: string;
  connectionType?: string;
  natEnabled?: boolean;
  bindings?: WanBindingData | null;
  editable?: boolean;
  nameConfigurable?: boolean;
  usernameConfigurable?: boolean;
  passwordConfigurable?: boolean;
  vlanConfigurable?: boolean;
  serviceListConfigurable?: boolean;
  connectionTypeConfigurable?: boolean;
  natConfigurable?: boolean;
  bindingsConfigurable?: boolean;
}

interface ProcessedDeviceDetail {
  _id: string;
  _lastInform?: string;
  _lastBoot?: string;
  _registered?: string;
  vendor: string;
  deviceInfo: {
    productclass?: string;
    serialNumber?: string;
    manufacturer?: string;
    oui?: string;
    hardwareVersion?: string;
    softwareVersion?: string;
    upTime?: string;
    macAddress?: string;
    wanMacAddress?: string | null;
    lanMacAddress?: string | null;
  };
  virtualParameters: {
    [key: string]: { path: string; value: any }
  };
  wifi: WifiNetwork[];
  wan: Array<WanConnection>;
  wanContainers: Array<{ path: string; label: string }>;
  clients: ClientDevice[];
  customer: {
    customerId: string | null;
    installationDate: string | null;
    generated: boolean;
    /** O id da LINHA da conta — o endereço das rotas do dossiê. Nulo quando não há conta. */
    accountId?: number | null;
    portalPasswordSet?: boolean;
    portalPasswordUpdatedAt?: string | null;
  };
  _raw?: any;
}

interface ClientDevice {
  instance: string;
  dataModel: string;
  hostName?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  interfaceType?: string | null;
  addressSource?: string | null;
  leaseTimeRemaining?: number | null;
  active: boolean | null;
}

interface WifiNetwork {
  index: number;
  enable: boolean | null;
  ssid: string;
  password?: string | null;
  security?: string | null;
  channel?: number | null;
  totalAssociations?: number | null;
  usesVirtualParameters?: boolean;
}

interface WifiFormState {
  enable: boolean;
  ssid: string;
  password: string;
  security: string;
  channel: string;
}

interface WanFormState {
  name: string;
  vlanEnabled: boolean;
  vlanId: string;
  username: string;
  password: string;
  serviceList: string;
  connectionType: string;
  natEnabled: boolean;
  bindings: {
    LAN1: boolean; LAN2: boolean; LAN3: boolean; LAN4: boolean;
    SSID1: boolean; SSID2: boolean; SSID3: boolean; SSID4: boolean;
    SSID5: boolean; SSID6: boolean; SSID7: boolean; SSID8: boolean;
  };
}

function EditWanModal({
  isOpen,
  onClose,
  wanData,
  onSave
}: {
  isOpen: boolean;
  onClose: () => void;
  wanData: WanConnection | null;
  onSave: (formData: WanFormState) => void;
}) {
  const [wanForm, setWanForm] = useState<WanFormState>({
    name: '',
    vlanEnabled: false,
    vlanId: '',
    username: '',
    password: '',
    serviceList: '',
    connectionType: 'IP_Routed',
    natEnabled: false,
    bindings: {
      LAN1: false, LAN2: false, LAN3: false, LAN4: false,
      SSID1: false, SSID2: false, SSID3: false, SSID4: false,
      SSID5: false, SSID6: false, SSID7: false, SSID8: false,
    }
  });

  const { t } = useTranslation();
  const [isVlanConfigurable, setIsVlanConfigurable] = useState(false);

  useEffect(() => {
    if (wanData) {
      const isVlanSet = wanData.vlanId !== null && wanData.vlanId !== undefined;
      setIsVlanConfigurable(Boolean(wanData.vlanConfigurable));

      const newBindings: WanFormState['bindings'] = {
        LAN1: false, LAN2: false, LAN3: false, LAN4: false,
        SSID1: false, SSID2: false, SSID3: false, SSID4: false,
        SSID5: false, SSID6: false, SSID7: false, SSID8: false,
      };
      wanData.bindings?.lan.forEach(lan => {
        if (lan in newBindings) newBindings[lan as keyof typeof newBindings] = true;
      });
      wanData.bindings?.ssid.forEach(ssid => {
        if (ssid in newBindings) newBindings[ssid as keyof typeof newBindings] = true;
      });

      setWanForm({
        name: wanData.name || '',
        vlanEnabled: isVlanSet,
        vlanId: isVlanSet ? String(wanData.vlanId) : '',
        username: wanData.username || '',
        password: '',
        serviceList: wanData.serviceList || '',
        connectionType: wanData.connectionType || 'IP_Routed',
        natEnabled: Boolean(wanData.natEnabled),
        bindings: newBindings
      });
    }
  }, [wanData]);

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, checked } = e.target;
    setWanForm(prev => ({
      ...prev,
      bindings: {
        ...prev.bindings,
        [name]: checked
      }
    }));
  };

  const handleSaveClick = () => {
    onSave(wanForm);
  };

  if (!isOpen || !wanData) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="wan-dialog-title">
      <div className="modal-panel modern-card flex max-w-2xl flex-col">
        {/* Header Modal */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <h3 id="wan-dialog-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('detail.wan.edit')}
          </h3>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>

        {/* Form Body */}
        <div className="p-5 sm:p-6 space-y-6 overflow-y-auto">
          {/* 1. WAN Name */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">{t('detail.wanModal.name')}</label>
            <input
              type="text"
              value={wanForm.name}
              maxLength={256}
              disabled={!wanData.nameConfigurable}
              onChange={(event) => setWanForm((current) => ({ ...current, name: event.target.value }))}
              placeholder={wanData.nameConfigurable ? t('detail.wanModal.namePlaceholder') : t('detail.wanModal.nameReadOnly')}
              className="modern-input w-full"
            />
          </div>

          {/* 2. VLAN */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">{t('detail.wanModal.vlan')}</label>
            <div className="flex items-center space-x-3">
              <input
                type="checkbox"
                id="vlanEnabled"
                checked={wanForm.vlanEnabled}
                onChange={(e) => setWanForm(f => ({ ...f, vlanEnabled: e.target.checked }))}
                disabled={!isVlanConfigurable}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:bg-gray-200 disabled:cursor-not-allowed"
              />
              <label
                htmlFor="vlanEnabled"
                className={`text-sm ${!isVlanConfigurable ? 'text-gray-400 dark:text-gray-500 cursor-not-allowed' : ''}`}
              >
                {t('detail.wanModal.enableVlan')}
              </label>
            </div>
            <input
              type="number"
              min={1}
              max={4094}
              value={wanForm.vlanId}
              onChange={(e) => setWanForm(f => ({ ...f, vlanId: e.target.value }))}
              disabled={!wanForm.vlanEnabled}
              placeholder={!isVlanConfigurable ? t('detail.wanModal.vlanNotAvailable') : (wanForm.vlanEnabled ? t('detail.wanModal.vlanPlaceholder') : t('detail.wanModal.vlanNotEnabled'))}
              className="modern-input w-full mt-2"
            />
          </div>

          {/* 3. PPP Username */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">{t('detail.wanModal.pppUsername')}</label>
            <input
              type="text"
              value={wanForm.username}
              disabled={!wanData.usernameConfigurable}
              onChange={(e) => setWanForm(f => ({ ...f, username: e.target.value }))}
              placeholder={wanData.usernameConfigurable ? t('detail.wanModal.usernamePlaceholder') : t('detail.wanModal.usernameReadOnly')}
              className="modern-input w-full font-mono"
            />
          </div>

          {/* 4. PPP Password */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">{t('detail.wanModal.pppPassword')}</label>
            <input
              type="password"
              value={wanForm.password}
              disabled={!wanData.passwordConfigurable}
              onChange={(e) => setWanForm(f => ({ ...f, password: e.target.value }))}
              placeholder={wanData.passwordConfigurable ? t('detail.wanModal.passwordPlaceholder') : t('detail.wanModal.passwordReadOnly')}
              className="modern-input w-full font-mono"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">{t('detail.wanModal.serviceList')}</label>
              <input
                type="text"
                value={wanForm.serviceList}
                maxLength={128}
                disabled={!wanData.serviceListConfigurable}
                onChange={(event) => setWanForm((current) => ({ ...current, serviceList: event.target.value }))}
                placeholder={wanData.serviceListConfigurable ? 'INTERNET' : t('detail.wanModal.serviceReadOnly')}
                className="modern-input w-full font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">{t('detail.wanModal.connectionMode')}</label>
              <select
                value={wanForm.connectionType}
                disabled={!wanData.connectionTypeConfigurable}
                onChange={(event) => setWanForm((current) => ({ ...current, connectionType: event.target.value }))}
                className="modern-input w-full"
              >
                <option value="IP_Routed">{t('detail.wanModal.routed')}</option>
                <option value="PPPoE_Bridged">{t('detail.wanModal.bridged')}</option>
              </select>
            </div>
          </div>

          <label className={`flex items-center gap-3 rounded-md border border-border p-3 ${wanData.natConfigurable ? 'cursor-pointer' : 'opacity-60'}`}>
            <input
              type="checkbox"
              checked={wanForm.natEnabled}
              disabled={!wanData.natConfigurable}
              onChange={(event) => setWanForm((current) => ({ ...current, natEnabled: event.target.checked }))}
              className="size-4 accent-[hsl(var(--primary))]"
            />
            <span>
              <span className="block text-sm font-semibold">{t('detail.wanModal.enableNat')}</span>
              <span className="block text-xs text-muted-foreground">
                {wanData.natConfigurable ? t('detail.wanModal.natHint') : t('detail.wanModal.natReadOnly')}
              </span>
            </span>
          </label>

          {/* 5. Interface Binding */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">{t('detail.wanModal.interfaceBinding')}</label>
            {!wanData.bindingsConfigurable && (
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                {t('detail.wanModal.bindingsReadOnly')}
              </p>
            )}
            <div className="space-y-4">
              {/* LAN */}
              <div>
                <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">{t('detail.wan.lanPorts')}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {([1, 2, 3, 4] as const).map(i => (
                    <label key={`lan-${i}`} className="flex items-center space-x-2 p-2 border dark:border-gray-700 rounded-md">
                      <input
                        type="checkbox"
                        name={`LAN${i}`}
                        checked={wanForm.bindings[`LAN${i}`]}
                        onChange={handleCheckboxChange}
                        disabled={!wanData.bindingsConfigurable}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm">LAN{i}</span>
                    </label>
                  ))}
                </div>
              </div>
              {/* WiFi */}
              <div>
                <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">{t('detail.wan.wifiNetworks')}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {([1, 2, 3, 4, 5, 6, 7, 8] as const).map(i => (
                    <label key={`ssid-${i}`} className="flex items-center space-x-2 p-2 border dark:border-gray-700 rounded-md">
                      <input
                        type="checkbox"
                        name={`SSID${i}`}
                        checked={wanForm.bindings[`SSID${i}`]}
                        onChange={handleCheckboxChange}
                        disabled={!wanData.bindingsConfigurable}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm">SSID{i}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Modal (Tombol Save) */}
        <div className="flex flex-wrap items-center justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="modern-button-secondary"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSaveClick}
            className="modern-button"
          >
            {t('detail.wanModal.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditCredentialModal({
  isOpen,
  onClose,
  credentialType,
  username,
  onSave
} : {
  isOpen: boolean;
  onClose: () => void;
  credentialType: 'super' | 'user' | null;
  username: string;
  onSave: (type: 'super' | 'user', password: string) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');

  const handleSaveClick = () => {
    if (credentialType && password) {
      onSave(credentialType, password);
      setPassword('');
    }
  };

  const title = credentialType === 'super' ? t('detail.credentials.superadmin') : t('detail.credentials.useradmin');

  if (!isOpen || !credentialType) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="credential-dialog-title">
      <div className="modal-panel modern-card flex max-w-md flex-col">
        {/* Header Modal */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <h3 id="credential-dialog-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('detail.credentials.title', { target: title })}
          </h3>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>

        {/* Form Body */}
        <div className="p-5 sm:p-6 space-y-4 overflow-y-auto">
           <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">{t('detail.credentials.username')}</label>
            <input
              type="text"
              value={username || t('common.na')}
              readOnly
              className="modern-input w-full bg-gray-100 dark:bg-gray-800 cursor-not-allowed"
            />
          </div>
           <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">{t('detail.credentials.newPassword')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('detail.credentials.newPasswordPlaceholder')}
              className="modern-input w-full font-mono"
            />
          </div>
        </div>

        {/* Footer Modal */}
        <div className="flex flex-wrap items-center justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="modern-button-secondary"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSaveClick}
            disabled={!password}
            className="modern-button"
          >
            {t('detail.credentials.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * O texto de cada ação sem volta que o diálogo abaixo confirma. A série e a
 * senha são pedidas do mesmo jeito nas duas, então esses rótulos são um só.
 */
const IRREVERSIBLE_TEXTS = {
  factoryReset: {
    title: 'detail.factoryReset.title',
    consequence: 'detail.factoryReset.consequence',
    confirm: 'detail.factoryReset.confirm',
    sending: 'detail.factoryReset.sending',
    failed: 'detail.factoryReset.failed'
  },
  remove: {
    title: 'detail.remove.title',
    consequence: 'detail.remove.consequence',
    confirm: 'detail.remove.confirm',
    sending: 'detail.remove.sending',
    failed: 'detail.remove.failed'
  }
} satisfies Record<string, Record<string, TranslationKey>>

type IrreversibleAction = keyof typeof IRREVERSIBLE_TEXTS

/**
 * As ações que não têm volta: o reset de fábrica e a remoção do GenieACS.
 *
 * Pede o número de série digitado, e não um "tem certeza?": a tela pode ter
 * ficado aberta noutro aparelho, e o que se quer impedir é o clique no aparelho
 * errado — um "OK" passa por reflexo, digitar a série do aparelho não.
 */
function IrreversibleActionModal({
  action,
  isOpen,
  onClose,
  deviceId,
  serial,
  lastInform,
  provisioningAvailable,
  onDone
}: {
  action: IrreversibleAction | null;
  isOpen: boolean;
  onClose: () => void;
  deviceId: string;
  serial: string | null;
  lastInform: string | null;
  provisioningAvailable: boolean;
  onDone: (action: IrreversibleAction) => void;
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [typed, setTyped] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [sending, setSending] = useState(false)

  // A senha nunca sobrevive ao diálogo: fechou, apagou.
  useEffect(() => {
    if (isOpen) {
      setTyped('')
      setPassword('')
      setPasswordConfirm('')
    }
  }, [isOpen])

  if (!isOpen || !action) return null

  const texts = IRREVERSIBLE_TEXTS[action]
  const alvo = serial || deviceId
  const confere = serialMatches(typed, serial, deviceId)
  // A senha duas vezes: o servidor confere as duas e que é a do operador; aqui
  // só se evita mandar um par que já se sabe diferente.
  const senhasDiferentes = passwordConfirm.length > 0 && password !== passwordConfirm
  const podeEnviar = confere && password.length > 0 && password === passwordConfirm

  const enviar = async () => {
    if (!podeEnviar) return
    setSending(true)
    try {
      const res = action === 'remove'
        ? await devicesAPI.deleteDevice(deviceId, typed, password, passwordConfirm)
        : await devicesAPI.factoryResetDevice(deviceId, typed, password, passwordConfirm)
      if (res.success) {
        toast.success(res.message || t(texts.title))
        onDone(action)
      } else {
        toast.error(res.message || t(texts.failed))
      }
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t(texts.failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="factory-reset-title">
      <div className="modal-panel modern-card flex max-w-md flex-col">
        <div className="flex items-center gap-2 border-b border-border p-5">
          <Icon name="warning" size={20} className="shrink-0 text-[hsl(var(--status-danger))]" />
          <h3 id="factory-reset-title" className="text-lg font-semibold text-foreground">{t(texts.title)}</h3>
        </div>
        <div className="space-y-3 overflow-y-auto p-5 text-sm leading-6">
          <p className="text-foreground">{t(texts.consequence)}</p>
          {action === 'remove' && informedRecently(lastInform) && (
            <p className="rounded-md border border-[hsl(var(--status-warning))]/50 bg-[hsl(var(--status-warning))]/10 px-3 py-2 text-[hsl(var(--status-warning))]">
              {t('detail.remove.onlineWarning')}
            </p>
          )}
          {action === 'factoryReset' && provisioningAvailable && (
            <p className="text-muted-foreground">{t('detail.factoryReset.provisionHint')}</p>
          )}
          <label htmlFor="factory-reset-serial" className="field-label mb-3 pt-1 wrap-anywhere">
            {t('detail.factoryReset.typeSerial', { serial: alvo })}
          </label>
          <input
            id="factory-reset-serial"
            type="text"
            autoComplete="off"
            spellCheck={false}
            className="modern-input w-full font-mono"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <label htmlFor="factory-reset-password" className="field-label pt-1">
            {t('detail.factoryReset.password')}
          </label>
          <input
            id="factory-reset-password"
            type="password"
            autoComplete="current-password"
            className="modern-input w-full"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <label htmlFor="factory-reset-password-confirm" className="field-label pt-1">
            {t('detail.factoryReset.passwordConfirm')}
          </label>
          <input
            id="factory-reset-password-confirm"
            type="password"
            autoComplete="current-password"
            className="modern-input w-full"
            aria-invalid={senhasDiferentes}
            aria-describedby={senhasDiferentes ? 'factory-reset-password-mismatch' : undefined}
            value={passwordConfirm}
            onChange={(event) => setPasswordConfirm(event.target.value)}
          />
          {senhasDiferentes && (
            <p id="factory-reset-password-mismatch" className="text-xs text-[hsl(var(--status-danger))]">
              {t('detail.factoryReset.passwordMismatch')}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border p-5">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={sending}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="modern-button-danger"
            disabled={!podeEnviar || sending}
            onClick={() => void enviar()}
          >
            <Icon name="warning" size={16} />
            {sending ? t(texts.sending) : t(texts.confirm)}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditWifiModal({
  wifi,
  onClose,
  onSave,
  saving
}: {
  wifi: WifiNetwork | null;
  onClose: () => void;
  onSave: (form: WifiFormState) => void;
  saving: boolean;
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<WifiFormState>({
    enable: true,
    ssid: '',
    password: '',
    security: '',
    channel: ''
  })

  useEffect(() => {
    if (!wifi) return
    setForm({
      enable: wifi.enable !== false,
      ssid: wifi.ssid || '',
      password: '',
      security: wifi.security || '',
      channel: wifi.channel === null || wifi.channel === undefined ? '' : String(wifi.channel)
    })
  }, [wifi])

  if (!wifi) return null

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="wifi-dialog-title">
      <div className="modal-panel modern-card flex max-w-lg flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div className="min-w-0">
            <h3 id="wifi-dialog-title" className="section-heading">{t('detail.wifiModal.title', { index: wifi.index })}</h3>
            <p className="section-description mt-1">
              {wifi.usesVirtualParameters ? t('detail.wifiModal.vpNote') : t('detail.wifiModal.tr098Note')}
            </p>
          </div>
          <button type="button" onClick={onClose} className="icon-button shrink-0" aria-label={t('detail.wifiModal.close')}>
            <Icon name="x" size={19} />
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto p-5">
          <label className="flex min-h-11 items-center justify-between gap-4 rounded-md border border-border bg-[hsl(var(--surface-subtle))] px-4">
            <span>
              <span className="block text-sm font-semibold">{t('detail.wifiModal.radioEnabled')}</span>
              <span className="block text-xs text-muted-foreground">{t('detail.wifiModal.radioHint')}</span>
            </span>
            <input type="checkbox" checked={form.enable} onChange={(event) => setForm((current) => ({ ...current, enable: event.target.checked }))} />
          </label>
          <div>
            <label htmlFor="wifi-ssid" className="field-label">{t('detail.wifiModal.ssidLabel')}</label>
            <input id="wifi-ssid" className="modern-input w-full" maxLength={32} value={form.ssid}
              onChange={(event) => setForm((current) => ({ ...current, ssid: event.target.value }))} />
            <p className="field-hint">{t('detail.wifiModal.ssidCount', { count: form.ssid.length })}</p>
          </div>
          <div>
            <label htmlFor="wifi-password" className="field-label">{t('detail.wifiModal.newPassword')}</label>
            <input id="wifi-password" type="password" className="modern-input w-full font-mono" minLength={8} maxLength={63}
              value={form.password} placeholder={t('detail.wifiModal.passwordPlaceholder')}
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} />
            <p className="field-hint">{t('detail.wifiModal.passwordHint')}</p>
          </div>
          <div>
            <label htmlFor="wifi-security" className="field-label">{t('detail.wifiModal.securityLabel')}</label>
            <input id="wifi-security" className="modern-input w-full" list="wifi-security-options" value={form.security}
              onChange={(event) => setForm((current) => ({ ...current, security: event.target.value }))} />
            <datalist id="wifi-security-options">
              <option value="None" />
              <option value="Basic" />
              <option value="WPA" />
              <option value="11i" />
              <option value="WPAand11i" />
            </datalist>
            <p className="field-hint">{t('detail.wifiModal.securityHint')}</p>
          </div>
          <div>
            <label htmlFor="wifi-channel" className="field-label">{t('detail.wifiModal.channel')}</label>
            <input id="wifi-channel" type="number" min={0} max={196} className="modern-input w-full"
              value={form.channel} placeholder={t('detail.wifiModal.channelPlaceholder')}
              onChange={(event) => setForm((current) => ({ ...current, channel: event.target.value }))} />
          </div>
          <div className="rounded-md border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] p-4 text-sm">
            {t('detail.wifiModal.warning')}
          </div>
        </div>
        {/* No celular "Aplicar alterações de WiFi" não cabe ao lado do Cancelar:
            empilha, com a ação principal em cima. */}
        <div className="flex flex-col-reverse gap-2 border-t border-border p-5 sm:flex-row sm:flex-wrap sm:justify-end">
          <button type="button" onClick={onClose} className="modern-button-secondary" disabled={saving}>{t('common.cancel')}</button>
          <button type="button" onClick={() => onSave(form)} className="modern-button" disabled={saving || !form.ssid.trim()}>
            {saving ? t('detail.wifiModal.queuing') : t('detail.wifiModal.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}


export default function DeviceDetailPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const deviceId = searchParams.get('id') || ''
  const [device, setDevice] = useState<ProcessedDeviceDetail | null>(null)
  // A frase do 503 `acs_agent_offline`, quando é por isso que não há equipamento.
  const [agentOffline, setAgentOffline] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')
  const [rebooting, setRebooting] = useState(false)
  const [irreversibleAction, setIrreversibleAction] = useState<IrreversibleAction | null>(null)
  const { can, user } = useAuth()
  // Revelar a senha do portal é `customers.secrets`, e mexer no CPE é
  // `devices.write` — capacidades distintas na matriz porque quem reinicia uma
  // ONT não precisa, por consequência, ler o segredo de um assinante. As duas
  // estavam sob `role === 'admin'`, que fechava para o plantão o próprio
  // trabalho dele.
  const canReadSecrets = can('customers.secrets')
  const canWriteDevice = can('devices.write')
  const canOpenContact = can('contacts.read')
  // O que não tem volta é do admin: o plantão reinicia, mas não apaga a
  // configuração do cliente.
  const canMaintainDevice = can('devices.maintain')
  const { t, formatDateTime, formatDate: formatDay, intlLocale } = useTranslation()
  const toast = useToast()
  const loadingCtl = useLoading()
  const [isWanModalOpen, setIsWanModalOpen] = useState(false)
  const [editingWan, setEditingWan] = useState<WanConnection | null>(null)
  const [isCredentialModalOpen, setIsCredentialModalOpen] = useState(false)
  const [credentialType, setCredentialType] = useState<'super' | 'user' | null>(null);
  const [editingWifi, setEditingWifi] = useState<WifiNetwork | null>(null)
  // `null` = ninguém escolheu ainda nesta visita à aba: vale o padrão
  // (Ativas, ou Todas quando não há rede ativa). Volta a `null` a cada
  // entrada na aba WiFi.
  const [wifiFilterChoice, setWifiFilterChoice] = useState<WifiStatusFilter | null>(null)
  const [savingWifi, setSavingWifi] = useState(false)
  const [installationDate, setInstallationDate] = useState('')
  const [savingInstallationDate, setSavingInstallationDate] = useState(false)
  const [portalPassword, setPortalPassword] = useState<string | null>(null)
  const [portalPasswordBusy, setPortalPasswordBusy] = useState(false)
  const [wanContainer, setWanContainer] = useState('')
  const [newWanType, setNewWanType] = useState<'ppp' | 'ip'>('ppp')
  const [addingWan, setAddingWan] = useState(false)
  const [sgpLink, setSgpLink] = useState<SgpContractLink | null>(null)
  const [sgpInvoices, setSgpInvoices] = useState<SgpInvoice[]>([])
  const [invoiceFilter, setInvoiceFilter] = useStoredChoice<InvoiceStatusFilter>('deviceDetail.invoiceFilter', parseInvoiceStatusFilter)
  const [sgpLoading, setSgpLoading] = useState(false)
  const [sgpMessage, setSgpMessage] = useState<string | null>(null)
  const [sgpAvailable, setSgpAvailable] = useState(false)
  const [sgpContractInput, setSgpContractInput] = useState('')
  const [sgpUnlocking, setSgpUnlocking] = useState(false)
  const [sgpTicketEnabled, setSgpTicketEnabled] = useState(false)
  const [sgpUrl, setSgpUrl] = useState<string | null>(null)
  const [openingWhatsApp, setOpeningWhatsApp] = useState(false)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [ticketText, setTicketText] = useState('')
  const [ticketSending, setTicketSending] = useState(false)


  const handleOpenEditModal = (wan: WanConnection) => {
    setEditingWan(wan);
    setIsWanModalOpen(true);
  }

  const handleCloseWanModal = () => {
    setIsWanModalOpen(false);
    setEditingWan(null);
  }

  // Declarado antes dos handlers que o chamam, e não depois deles: ver a
  // regra `no-use-before-define` no eslint.config.
  const fetchDeviceDetails = useCallback(async (isRefresh = false) => {
    if (!isRefresh) {
      setLoading(true);
    }

    try {
      if (!deviceId) {
        setDevice(null)
        return
      }
      const res = await devicesAPI.getDevice(deviceId)
      if (res.success && res.data) {
        const nextDevice = res.data as ProcessedDeviceDetail
        setAgentOffline(null)
        setDevice(nextDevice)
        setInstallationDate(nextDevice.customer?.installationDate || '')
        setWanContainer((current) => current || nextDevice.wanContainers?.[0]?.path || '')
      } else {
        // Agente desconectado não é "equipamento não encontrado": a tela vazia
        // diz o que houve em vez de mandar a pessoa de volta à lista, que vai
        // falhar igual. Uma releitura (o `isRefresh` depois de salvar) que cai
        // aqui também troca a tela — o equipamento na tela já não é o de agora.
        setAgentOffline(res.code === 'acs_agent_offline' ? (res.message || t('detail.loadFailed')) : null)
        if (res.code !== 'acs_agent_offline') toast.error(res.message || t('detail.loadFailed'))
        setDevice(null)
      }
    } catch (error) {
      console.error('Error fetching device details:', error)
      toast.error(t('detail.networkError'))
    } finally {
      setLoading(false);
    }
  }, [deviceId, t, toast])

  const handleSaveWan = async (formData: WanFormState) => {
    if (!editingWan) return;
    if (formData.vlanEnabled) {
      const vlanId = Number(formData.vlanId)
      if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
        toast.error(t('detail.wan.vlanRange'))
        return
      }
    }

    loadingCtl.show(t('detail.wan.saving'));
    try {
      const res = await devicesAPI.updateWanConfig(deviceId, editingWan.index, formData);

      if (res.success) {
        toast.success(res.message || t('detail.wan.updated'));
        handleCloseWanModal();

        setTimeout(() => {
          fetchDeviceDetails(true);
        }, 1500);

      } else {
        toast.error(res.message || t('detail.wan.updateFailed'));
      }
    } catch (error: any) {
      toast.error(error.message || t('detail.wan.saveFailed'));
    } finally {
      loadingCtl.hide();
    }
  }

  const handleOpenCredentialModal = (type: 'super' | 'user') => {
    setCredentialType(type);
    setIsCredentialModalOpen(true);
  }

  const handleCloseCredentialModal = () => {
    setIsCredentialModalOpen(false);
    setCredentialType(null);
  }

  const handleSaveCredentials = async (type: 'super' | 'user', password: string) => {
    loadingCtl.show(t('detail.credentials.updating'));
    try {
      const res = await devicesAPI.updateCredentials(deviceId, type, password);

      if (res.success) {
        toast.success(res.message || t('detail.credentials.queued'));
        handleCloseCredentialModal();
        setTimeout(() => {
          fetchDeviceDetails(true);
        }, 1500);
      } else {
        toast.error(res.message || t('detail.credentials.failed'));
      }
    } catch (error: any) {
      toast.error(error.message || t('detail.credentials.failed'));
    } finally {
      loadingCtl.hide();
    }
  }

  const handleSaveWifi = async (formData: WifiFormState) => {
    if (!editingWifi) return
    if (formData.password && (formData.password.length < 8 || formData.password.length > 63)) {
      toast.error(t('detail.wifiModal.passwordLength'))
      return
    }
    setSavingWifi(true)
    loadingCtl.show(t('detail.wifiModal.queuingProgress', { index: editingWifi.index }))
    try {
      const res = await devicesAPI.updateWifiConfig(deviceId, editingWifi.index, formData)
      if (!res.success) {
        toast.error(res.message || t('detail.wifiModal.updateFailed'))
        return
      }
      setDevice((current) => current ? {
        ...current,
        wifi: current.wifi.map((network) => network.index === editingWifi.index ? {
          ...network,
          enable: formData.enable,
          ssid: formData.ssid,
          security: formData.security || network.security,
          channel: formData.channel === '' ? network.channel : Number(formData.channel)
        } : network)
      } : current)
      toast.success(res.message || t('detail.wifiModal.updateQueued'))
      setEditingWifi(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('detail.wifiModal.updateFailed'))
    } finally {
      setSavingWifi(false)
      loadingCtl.hide()
    }
  }


  // An SGP due date is a plain YYYY-MM-DD; anchor it to local midnight so the
  // reader's locale, not UTC, decides the displayed day.
  const invoiceDueDate = (value: string | null) => (value ? formatDay(value) : '—')

  /* O selo de situação, calculado uma vez e usado nos dois lugares que o
     mostram: a faixa do topo e o bloco do SGP. Aguenta `sgpLink` nulo, então
     não precisa de guarda em volta. */
  const selo = sgpBadge(sgpLink)

  const loadSgpData = useCallback(async (refresh = false) => {
    if (!deviceId) return
    setSgpLoading(true)
    setSgpMessage(null)
    try {
      const res = await sgpAPI.getDeviceIntegration(deviceId, { refresh })
      if (res.success && res.data) {
        setSgpAvailable(true)
        setSgpLink(res.data.link)
        setSgpInvoices(res.data.invoices || [])
        setSgpMessage(res.data.invoiceError)
        setSgpTicketEnabled(res.data.ticketEnabled === true)
        setSgpUrl(res.data.sgpUrl ?? null)
        return
      }
      setSgpLink(null)
      setSgpUrl(null)
      setSgpInvoices([])
      // The card stays hidden while the integration is switched off.
      setSgpAvailable(res.code !== 'not_configured')
      setSgpMessage(res.message || t('detail.sgp.queryFailed'))
    } finally {
      setSgpLoading(false)
    }
  }, [deviceId, t])

  useEffect(() => {
    void loadSgpData(false)
  }, [loadSgpData])

  const handleSgpLink = async () => {
    const contract = sgpContractInput.trim()
    if (!contract) {
      toast.error(t('detail.sgp.linkRequired'))
      return
    }
    setSgpLoading(true)
    try {
      const res = await sgpAPI.linkDevice(deviceId, { contract })
      if (!res.success) {
        toast.error(res.message || t('detail.sgp.linkFailed'))
        return
      }
      toast.success(res.message || t('detail.sgp.linked'))
      setSgpContractInput('')
      await loadSgpData(false)
    } finally {
      setSgpLoading(false)
    }
  }

  const handleSgpUnlink = async () => {
    if (!confirm(t('detail.sgp.unlinkConfirm'))) return
    const res = await sgpAPI.unlinkDevice(deviceId)
    if (!res.success) {
      toast.error(res.message || t('detail.sgp.unlinkFailed'))
      return
    }
    setSgpLink(null)
    setSgpInvoices([])
    setSgpMessage(null)
    toast.success(res.message || t('detail.sgp.unlinked'))
  }

  const handleSgpUnlock = async () => {
    if (!confirm(t('detail.sgp.unlockConfirm'))) return
    setSgpUnlocking(true)
    try {
      const res = await sgpAPI.requestTrustUnlock(deviceId)
      toast[res.success ? 'success' : 'error'](res.message || t('detail.sgp.unlockSent'))
    } finally {
      setSgpUnlocking(false)
    }
  }

  /**
   * O formulário do chamado, para o botão do TOPO poder levar até ele.
   *
   * Ele mora dentro do bloco do SGP, lá embaixo. Sem isto, clicar em "Abrir
   * chamado" no cabeçalho abriria um campo de texto fora da tela e a impressão
   * seria a de um botão que não faz nada.
   */
  const ticketFormRef = useRef<HTMLDivElement | null>(null)

  /* `nearest` e não `center`: quem clicou no botão do bloco já está olhando
     para o formulário, e ali isto não rola nada. Quem clicou no do cabeçalho é
     levado até ele. A mesma chamada serve aos dois sem saber de qual veio. */
  useEffect(() => {
    if (ticketOpen) {
      ticketFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [ticketOpen])

  const handleOpenTicket = async () => {
    const content = ticketText.trim()
    if (!content) {
      toast.error(t('detail.sgp.ticketContentRequired'))
      return
    }
    setTicketSending(true)
    try {
      const res = await sgpAPI.openTicket(deviceId, { content })
      if (!res.success) {
        toast.error(res.message || t('detail.sgp.ticketFailed'))
        return
      }
      // The protocol number is what the subscriber will quote back, so it is
      // shown rather than a bare "done".
      toast.success(res.data?.ticket
        ? t('detail.sgp.ticketOpenedWithNumber', { number: res.data.ticket })
        : res.message || t('detail.sgp.ticketOpened'))
      setTicketOpen(false)
      setTicketText('')
    } finally {
      setTicketSending(false)
    }
  }

  const handleSaveInstallationDate = async () => {
    if (!installationDate) {
      toast.error(t('detail.customer.selectDate'))
      return
    }
    setSavingInstallationDate(true)
    try {
      const res = await devicesAPI.updateInstallationDate(deviceId, installationDate)
      if (!res.success) {
        toast.error(res.message || t('detail.customer.dateSaveFailed'))
        return
      }
      const result = res.data as { customerId?: string | null; installationDate?: string }
      setDevice((current) => current ? {
        ...current,
        customer: {
          ...current.customer,
          customerId: result.customerId ?? current.customer?.customerId ?? null,
          installationDate: result.installationDate || installationDate,
          generated: Boolean(result.customerId ?? current.customer?.customerId)
        }
      } : current)
      toast.success(res.message || t('detail.customer.dateSaved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('detail.customer.dateSaveFailed'))
    } finally {
      setSavingInstallationDate(false)
    }
  }

  const handleRevealPortalPassword = async () => {
    setPortalPasswordBusy(true)
    try {
      const res = await devicesAPI.getPortalPassword(deviceId)
      if (!res.success || !res.data) {
        toast.error(res.message || t('detail.portalPassword.readFailed'))
        return
      }
      setPortalPassword(res.data.password)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('detail.portalPassword.readFailed'))
    } finally {
      setPortalPasswordBusy(false)
    }
  }

  const handleResetPortalPassword = async () => {
    if (!window.confirm(t('detail.portalPassword.confirmReset'))) {
      return
    }
    setPortalPasswordBusy(true)
    try {
      const res = await devicesAPI.resetPortalPassword(deviceId)
      if (!res.success || !res.data) {
        toast.error(res.message || t('detail.portalPassword.resetFailed'))
        return
      }
      setPortalPassword(res.data.password)
      setDevice((current) => current ? {
        ...current,
        customer: {
          ...current.customer,
          portalPasswordSet: true,
          portalPasswordUpdatedAt: new Date().toISOString()
        }
      } : current)
      toast.success(t('detail.portalPassword.reset'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('detail.portalPassword.resetFailed'))
    } finally {
      setPortalPasswordBusy(false)
    }
  }

  const handleAddWan = async () => {
    if (!wanContainer) {
      toast.error(t('detail.wan.containerMissing'))
      return
    }
    setAddingWan(true)
    try {
      const res = await devicesAPI.addWanConnection(deviceId, wanContainer, newWanType)
      if (!res.success) {
        toast.error(res.message || t('detail.wan.addFailed'))
        return
      }
      toast.success(res.message || t('detail.wan.addQueued'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('detail.wan.addFailed'))
    } finally {
      setAddingWan(false)
    }
  }

  useEffect(() => {
    fetchDeviceDetails(false);
  }, [fetchDeviceDetails]);

  const handleReboot = async () => {
    if (!window.confirm(t('detail.rebootConfirm', { device: device?._id || deviceId }))) {
      return
    }
    setRebooting(true)
    loadingCtl.show(t('detail.rebootSending'))
    try {
      const res = await devicesAPI.rebootDevice(deviceId)
      if (res.success) {
        toast.success(t('detail.rebootSent'))
      } else {
        toast.error(res.message || t('detail.rebootFailed'))
      }
    } catch {
      toast.error(t('detail.rebootError'))
    } finally {
      setRebooting(false)
      loadingCtl.hide()
    }
  }

  const handleSummon = async () => {
    loadingCtl.show(t('devices.summon.loading'))
    try {
      const res = await devicesAPI.summonDevice(deviceId)
      if (res.success && res.data?.reached === false) {
        toast.warning(summonDeferredMessage(res.data, t, formatDateTime, res.message || t('devices.summon.success')))
      } else if (res.success) {
        toast.success(res.message || t('devices.summon.success'))
      } else {
        toast.error(res.message || t('devices.summon.failed'))
      }
    } catch {
      toast.error(t('devices.summon.error'))
    } finally {
      loadingCtl.hide()
    }
  }

  // A faixa sai de `lib/rx-signal` — ver `pages/devices.tsx`, que tinha a
  // mesma cópia.
  const getSignalStrengthInfo = (rxPowerStr: string | number | null | undefined) => {
    const estilo = RX_BAND_STYLE[rxBand(rxPowerStr)]
    return { color: estilo.color, label: t(estilo.labelKey), badgeClass: estilo.badgeClass }
  }

  const getStatusBadge = (status: string | undefined) => {
    if (!status) return <span className="modern-badge">{t('common.unknown')}</span>

    if (status.includes(':') || status.includes('Z')) {
       try {
         const lastSeen = new Date(status)
         if (Number.isNaN(lastSeen.getTime())) {
           return <span className="modern-badge">{t('common.invalidDate')}</span>
         }
         const now = new Date()
         const diffMinutes = Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60))

         if (diffMinutes < 10) {
           return <span className="modern-badge-success">{t('detail.status.online')}</span>
         } else if (diffMinutes < 60) {
           return <span className="modern-badge-warning">{t('detail.status.away')}</span>
         } else {
           return <span className="modern-badge-error">{t('detail.status.offline')}</span>
         }
       } catch {
          return <span className="modern-badge">{t('common.invalidDate')}</span>
       }
    }

    switch (status.toLowerCase()) {
      case 'connected':
        return <span className="modern-badge-success">{t('detail.status.connected')}</span>
      case 'disconnected':
        return <span className="modern-badge-error">{t('detail.status.disconnected')}</span>
      case 'connecting':
        return <span className="modern-badge-warning">{t('detail.status.connecting')}</span>
      case 'idle':
        return <span className="modern-badge-warning">{t('detail.status.idle')}</span>
      default:
        return <span className="modern-badge">{status}</span>
    }
  }

  const renderBindingBox = (label: string, isBound: boolean) => (
    <div className={`
      relative flex flex-col items-center justify-center p-2 rounded-md
      transition-all duration-200 ease-in-out
      ${isBound
        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 border border-blue-300 dark:border-blue-700'
        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700'
      }
    `}>
      {isBound && (
        <svg className="w-6 h-6 text-blue-500 dark:text-blue-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
      )}
      {!isBound && (
         <div className="w-6 h-6 mb-1 flex items-center justify-center text-gray-400 dark:text-gray-600">
           <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
           </svg>
         </div>
      )}
      <span className="text-xs font-semibold">{label}</span>
    </div>
  )

  if (loading) {
    return (
      <div className="page-shell">
        <div className="page-frame">
          <div className="mb-5 h-28 animate-pulse rounded-md bg-muted" />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="h-64 animate-pulse rounded-md bg-muted" />
            <div className="h-64 animate-pulse rounded-md bg-muted" />
          </div>
        </div>
      </div>
    )
  }

  if (!device && agentOffline) {
    return (
      <div className="page-shell">
        <div className="page-frame">
          <div className="modern-card empty-state" role="alert">
            <div className="empty-state-icon text-[hsl(var(--status-danger))]"><Icon name="warning" size={22} /></div>
            <h2 className="empty-state-title">{t('detail.agentOffline.title')}</h2>
            <p className="empty-state-copy">{agentOffline}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => void fetchDeviceDetails()} className="modern-button">
                {t('devices.error.retry')}
              </button>
              <button type="button" onClick={() => navigate('/devices')} className="modern-button-secondary">
                {t('detail.notFound.back')}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!device) {
    return (
      <div className="page-shell">
        <div className="page-frame">
          <div className="modern-card empty-state">
            <div className="empty-state-icon"><Icon name="server" size={22} /></div>
            <h2 className="empty-state-title">{t('detail.notFound.title')}</h2>
            <p className="empty-state-copy">{t('detail.notFound.copy')}</p>
            <button
              onClick={() => navigate('/devices')} className="modern-button mt-5"
            >
              {t('detail.notFound.back')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const vp = device.virtualParameters || {}
  const deviceInfo = device.deviceInfo || {}
  const primaryWAN = (device.wan && device.wan.length > 0) ? device.wan[0] : null
  const signalInfo = getSignalStrengthInfo(vp.rxpower?.value);
  const wifiNetworks = device.wifi ?? []
  const wifiEnabledCount = wifiNetworks.filter((ssid) => ssid.enable === true).length
  const wifiFilter: WifiStatusFilter = wifiFilterChoice ?? (wifiEnabledCount > 0 ? 'enabled' : 'all')
  const { visible: filteredWifi, counts: wifiCounts } = filterWifiByStatus(wifiNetworks, wifiFilter, (ssid) => ssid.enable)
  const { visible: visibleInvoices, counts: invoiceCounts } = filterInvoicesByStatus(sgpInvoices, invoiceFilter)

  /**
   * Abre (ou fecha) o formulário do chamado. Um só caminho para os dois botões
   * que o acionam — o do cabeçalho e o do bloco —, senão o texto semeado passa
   * a depender de por onde se clicou.
   *
   * Mora AQUI, depois de `vp`, e não junto do resto dos manipuladores: o texto
   * semeado lê a potência óptica, que só existe a partir desta linha.
   */
  const toggleTicket = () => {
    // Semeado com a ONT e a leitura óptica do momento: exatamente o que um
    // chamado aberto por telefone nunca carrega, e o que a equipe de campo
    // precisa.
    if (!ticketOpen && !ticketText) {
      setTicketText(t('detail.sgp.ticketDefaultText', {
        device: deviceId,
        rx: vp.rxpower?.value ?? '—'
      }))
    }
    // O formulário mora DENTRO da aba Visão geral. O botão do cabeçalho está
    // visível nas cinco abas, então sem esta linha clicar nele estando em WiFi
    // ou em Clientes abriria um campo que não é renderizado — nada na tela, e
    // a impressão de um botão quebrado.
    if (!ticketOpen) setActiveTab('overview')
    setTicketOpen((open) => !open)
  }

  /**
   * Opens this subscriber's WhatsApp thread — the one already there, or a new
   * one on the contract's number — and lands on it in the inbox. The route
   * refuses a contract with no number on record, and says so.
   */
  const openWhatsApp = async () => {
    if (!sgpLink) return
    setOpeningWhatsApp(true)
    try {
      const res = await whatsappAPI.openContactConversation(sgpLink.contract)
      if (!res.success || !res.data) {
        toast.error(res.message || t('api.requestFailed'))
        return
      }
      navigate('/whatsapp', { state: { conversation: res.data, owner: sessionOwner(user) } })
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setOpeningWhatsApp(false)
    }
  }

  // Os botões do topo, cada um só quando o perfil e o contrato o permitem.
  const contractActions = Boolean(sgpAvailable && sgpLink)
  // O login PPPoE que o equipamento reporta: é o elo entre ele e o ponto do mapa.
  const devicePppoe = device?.wan?.find((connection) => String(connection.username ?? '').trim())?.username?.trim() || ''
  const headerActions: Array<{ key: string; label: string; render: () => ReactNode }> = [
    {
      key: 'reboot',
      label: t('detail.reboot'),
      render: () => (
        <button key="reboot" onClick={handleReboot} disabled={rebooting} className="modern-button-secondary">
          <Icon name="power" size={17} />
          {rebooting ? t('detail.rebooting') : t('detail.reboot')}
        </button>
      )
    },
    ...(canMaintainDevice ? [{
      key: 'factoryReset',
      label: t('detail.factoryReset.button'),
      render: () => (
        <button
          key="factoryReset"
          type="button"
          onClick={() => setIrreversibleAction('factoryReset')}
          className="modern-button-secondary text-[hsl(var(--status-danger))]"
        >
          <Icon name="warning" size={17} />
          {t('detail.factoryReset.button')}
        </button>
      )
    }, {
      key: 'remove',
      label: t('detail.remove.button'),
      render: () => (
        <button
          key="remove"
          type="button"
          onClick={() => setIrreversibleAction('remove')}
          className="modern-button-secondary text-[hsl(var(--status-danger))]"
        >
          <Icon name="trash" size={17} />
          {t('detail.remove.button')}
        </button>
      )
    }] : []),
    {
      key: 'summon',
      label: t('detail.requestInform'),
      render: () => (
        <button
          key="summon"
          onClick={handleSummon}
          className="modern-button inline-flex items-center gap-1.5"
          title={t('detail.summonTitle')}
        >
          <Icon name="bell" size={16} /> {t('detail.requestInform')}
        </button>
      )
    },
    ...(contractActions ? [{
      key: 'unlock',
      label: t('detail.sgp.unlock'),
      render: () => (
        <button
          key="unlock"
          type="button"
          className="modern-button-secondary"
          disabled={sgpUnlocking}
          onClick={() => void handleSgpUnlock()}
        >
          <Icon name="unlock" size={16} />
          {sgpUnlocking ? t('detail.sgp.unlocking') : t('detail.sgp.unlock')}
        </button>
      )
    }] : []),
    ...(contractActions && sgpTicketEnabled ? [{
      key: 'ticket',
      label: t('detail.sgp.ticket'),
      render: () => (
        <button key="ticket" type="button" className="modern-button-secondary" onClick={toggleTicket}>
          <Icon name="chat" size={16} />
          {t('detail.sgp.ticket')}
        </button>
      )
    }] : []),
    ...(contractActions && isSafeExternalUrl(sgpUrl) ? [{
      key: 'openSgp',
      label: t('detail.sgp.openSgp'),
      render: () => (
        <a
          key="openSgp"
          className="modern-button-secondary"
          href={sgpUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="external" size={16} />
          {t('detail.sgp.openSgp')}
        </a>
      )
    }] : []),
    // Leva ao mapa com o login deste equipamento: se ele já tem ponto, o mapa
    // abre o ponto; se não, o diálogo de colocá-lo (quem pode editar o mapa).
    ...(devicePppoe && can('map.read') ? [{
      key: 'placeOnMap',
      label: t('detail.placeOnMap'),
      render: () => (
        <button
          key="placeOnMap"
          type="button"
          className="modern-button-secondary"
          onClick={() => navigate(`/network-map?place=${encodeURIComponent(devicePppoe)}&device=${encodeURIComponent(device?._id ?? '')}`)}
        >
          <Icon name="map" size={16} />
          {t('detail.placeOnMap')}
        </button>
      )
    }] : []),
    ...(contractActions && can('whatsapp.send') ? [{
      key: 'whatsapp',
      label: t('detail.sgp.openWhatsapp'),
      render: () => (
        <button
          key="whatsapp"
          type="button"
          className="modern-button-secondary"
          disabled={openingWhatsApp}
          onClick={() => void openWhatsApp()}
        >
          <Icon name="phone" size={16} />
          {t('detail.sgp.openWhatsapp')}
        </button>
      )
    }] : [])
  ].sort((a, b) => a.label.localeCompare(b.label, intlLocale, { sensitivity: 'base' }))

  return (
    <div className="page-shell">
      <div className="page-frame">
        {/* Entre sm e lg a fileira de botões espremia o título numa coluna
            estreita: ali o cabeçalho continua empilhado, como no celular. */}
        <header className="page-header sm:flex-col sm:items-stretch lg:flex-row lg:items-end">
          <div className="min-w-0">
            <div className="mb-3">
              <button
                onClick={() => navigate('/devices')}
                className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
              >
                <Icon name="back" size={17} /> {t('detail.back')}
              </button>
            </div>
            <p className="page-kicker">{t('detail.kicker')}</p>
            <h1 className="page-title break-all">
              {deviceInfo.serialNumber || device._id}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {getStatusBadge(device._lastInform)}
              <span className="text-xs text-muted-foreground">
                {t('detail.lastInform', { time: formatDate(device._lastInform) })}
              </span>
              <span className="max-w-full truncate font-mono text-[0.68rem] text-muted-foreground">{device._id}</span>
              <span className={device.customer?.customerId ? 'modern-badge-info font-mono' : 'modern-badge'}>
                {device.customer?.customerId || t('detail.customerIdMissing')}
              </span>
            </div>
          </div>
          {/* Em ordem alfabética pelo nome traduzido, em qualquer idioma: quem
              procura um botão lê a fileira, e a ordem não pode depender de quais
              ações o perfil ou o contrato liberam. Ordena pelo nome FIXO de cada
              ação, não pelo "…ando" de quando está em andamento, para o botão
              não pular de lugar no meio do clique.

              As ações do CONTRATO (liberação, chamado, SGP, WhatsApp) repetem as
              do bloco do SGP: quem está no telefone age antes de rolar a página.
              Todas secundárias — o verde já é o "Solicitar Inform". */}
          <div className="grid grid-cols-2 gap-2 text-center sm:flex sm:flex-wrap sm:items-center sm:text-start [&_svg]:shrink-0">
            {headerActions.map((action) => action.render())}
          </div>
        </header>

        {/* A faixa do cliente.
            FORA do switch de abas, de propósito: o bloco do SGP mora dentro da
            Visão geral, então hoje o nome do assinante some ao clicar em WiFi
            ou em Clientes. Quem está no telefone precisa saber com quem fala em
            qualquer aba.

            Repete o que o bloco de baixo mostra, e não o substitui: lá ficam as
            faturas, o chamado e o desvincular. Aqui é só quem é o cliente. */}
        {sgpAvailable && sgpLink && (
          <div className="mb-6 rounded-(--radius) border border-border bg-card p-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="min-w-0">
                <p className="metric-label">{t('detail.sgp.client')}</p>
                <p className="mt-1 truncate font-semibold" title={sgpLink.clientName || undefined}>
                  <ClientName link={sgpLink} canOpen={canOpenContact} />
                </p>
              </div>
              <div className="min-w-0">
                <p className="metric-label">{t('detail.sgp.contract')}</p>
                <p className="mt-1 font-mono font-semibold">{sgpLink.contract}</p>
              </div>
              <div className="min-w-0">
                <p className="metric-label">{t('detail.sgp.plan')}</p>
                <p className="mt-1 truncate font-semibold" title={sgpLink.plan || undefined}>
                  {sgpLink.plan || '—'}
                </p>
              </div>
              <div className="min-w-0">
                <p className="metric-label">{t('detail.sgp.status')}</p>
                <p className="mt-1">
                  <span className={selo.className}>{selo.text ?? t(selo.fallbackKey)}</span>
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Device Info Cards */}
        <div className="mb-6 grid grid-cols-2 overflow-hidden rounded-(--radius) border border-border bg-card lg:grid-cols-4">
          <div className="min-w-0 border-b border-e border-border p-4 lg:border-b-0">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('detail.metric.signal')}</span>
              <span className={signalInfo.badgeClass}>{signalInfo.label}</span>
            </div>
            <div className={`text-2xl font-bold ${signalInfo.color}`}>
              {vp.rxpower?.value !== null && vp.rxpower?.value !== undefined ? `${vp.rxpower.value} dBm` : t('common.na')}
            </div>
          </div>
          <div className="min-w-0 border-b border-border p-4 lg:border-b-0 lg:border-e">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('detail.metric.temperature')}</span>
              <Icon name="thermometer" size={20} className="text-gray-400 dark:text-gray-500" />
            </div>
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {vp.temperature?.value ?? t('common.na')}
            </div>
          </div>
          <div className="min-w-0 border-e border-border p-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('detail.metric.activeDevices')}</span>
              <Icon name="phone" size={20} className="text-gray-400 dark:text-gray-500" />
            </div>
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {vp.activedevices?.value || 0}
            </div>
          </div>
          <div className="min-w-0 p-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('detail.metric.model')}</span>
              <Icon name="server" size={20} className="text-gray-400 dark:text-gray-500" />
            </div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100 wrap-anywhere">
              {deviceInfo.productclass || t('common.na')}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6">
          <div className="tab-rail" role="tablist" aria-label={t('detail.tabsAria')}>
            <button
              onClick={() => setActiveTab('overview')}
              className="tab-button"
              data-active={activeTab === 'overview'}
              role="tab"
              aria-selected={activeTab === 'overview'}
            >
              {t('detail.tab.overview')}
            </button>
            <button
              onClick={() => setActiveTab('wan')}
              className="tab-button"
              data-active={activeTab === 'wan'}
              role="tab"
              aria-selected={activeTab === 'wan'}
            >
              {t('detail.tab.wan')}
            </button>
            <button
              onClick={() => { setActiveTab('wifi'); setWifiFilterChoice(null) }}
              className="tab-button"
              data-active={activeTab === 'wifi'}
              role="tab"
              aria-selected={activeTab === 'wifi'}
            >
              {t('detail.tab.wifi')}
            </button>
            <button
              onClick={() => setActiveTab('clients')}
              className="tab-button"
              data-active={activeTab === 'clients'}
              role="tab"
              aria-selected={activeTab === 'clients'}
            >
              {t('detail.tab.clients', { count: device.clients?.length || 0 })}
            </button>
            <button
              onClick={() => setActiveTab('advanced')}
              className="tab-button"
              data-active={activeTab === 'advanced'}
              role="tab"
              aria-selected={activeTab === 'advanced'}
            >
              {t('detail.tab.advanced')}
            </button>
          </div>
        </div>

        {/* Tab Overview */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="modern-card p-5 sm:p-6">
              <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">{t('detail.info.title')}</h2>
              <div className="space-y-3">
                <div className={KV_ROW}>
                  <span className="text-gray-600 dark:text-gray-400">{t('detail.info.deviceId')}:</span>
                  <span className="font-mono text-sm">{device._id}</span>
                </div>
                <div className={KV_ROW}>
                  <span className="text-gray-600 dark:text-gray-400">{t('detail.info.serialNumber')}:</span>
                  <span className="font-mono text-sm">{deviceInfo.serialNumber || t('common.na')}</span>
                </div>
                <div className={KV_ROW}>
                  <span className="text-gray-600 dark:text-gray-400">{t('detail.info.manufacturer')}:</span>
                  <span>{deviceInfo.manufacturer || t('common.na')}</span>
                </div>
                <div className={KV_ROW}>
                  <span className="text-gray-600 dark:text-gray-400">{t('detail.info.productClass')}:</span>
                  <span>{deviceInfo.productclass || t('common.na')}</span>
                </div>
                {/* O MAC WAN é o que o SGP mostra na sessão PPPoE — é por ele
                    que se confere, no ERP, qual assinante está neste ONT. */}
                <div className={KV_ROW}>
                  <span className="text-gray-600 dark:text-gray-400">{t('detail.info.wanMac')}:</span>
                  <span className="font-mono text-sm">{deviceInfo.wanMacAddress || t('common.na')}</span>
                </div>
                <div className={KV_ROW}>
                  <span className="text-gray-600 dark:text-gray-400">{t('detail.info.lanMac')}:</span>
                  <span className="font-mono text-sm">{deviceInfo.lanMacAddress || t('common.na')}</span>
                </div>
                <div className={KV_ROW}>
                  <span className="text-gray-600 dark:text-gray-400">{t('detail.info.hardwareVersion')}:</span>
                  <span>{deviceInfo.hardwareVersion || t('common.na')}</span>
                </div>
                <div className={KV_ROW}>
                  <span className="text-gray-600 dark:text-gray-400">{t('detail.info.softwareVersion')}:</span>
                  <span>{deviceInfo.softwareVersion || t('common.na')}</span>
                </div>
                <div className={KV_ROW}>
                  <span className="text-gray-600 dark:text-gray-400">{t('detail.info.lastBoot')}:</span>
                  <span>{formatDate(device._lastBoot)}</span>
                </div>
                <div className={KV_ROW}>
                  <span className="text-gray-600 dark:text-gray-400">{t('detail.info.lastRegistered')}:</span>
                  <span>{formatDate(device._registered)}</span>
                </div>
              </div>
            </div>

            <div className="modern-card p-5 sm:p-6">
              <p className="page-kicker">{t('detail.customer.kicker')}</p>
              <h2 className="section-heading">{t('detail.customer.title')}</h2>
              <p className="mt-3 break-all font-mono text-lg font-bold">
                {device.customer?.customerId || t('detail.customer.notGenerated')}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t('detail.customer.hint')}
              </p>
              {canReadSecrets && device.customer?.customerId && (
                <div className="mt-5 border-t border-border pt-4">
                  <p className="field-label">{t('detail.portalPassword.label')}</p>
                  {portalPassword ? (
                    <p className="break-all font-mono text-lg font-bold">{portalPassword}</p>
                  ) : (
                    <p className="font-mono text-lg font-bold tracking-widest">••••••••••</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="modern-button-secondary"
                      disabled={portalPasswordBusy || !device.customer?.portalPasswordSet}
                      onClick={() => void handleRevealPortalPassword()}
                    >
                      {portalPasswordBusy ? t('detail.portalPassword.working') : t('detail.portalPassword.reveal')}
                    </button>
                    <button
                      type="button"
                      className="modern-button"
                      disabled={portalPasswordBusy}
                      onClick={() => void handleResetPortalPassword()}
                    >
                      {t('detail.portalPassword.generate')}
                    </button>
                  </div>
                  <p className="field-hint">
                    {device.customer?.portalPasswordUpdatedAt
                      ? t('detail.portalPassword.lastChanged', { time: formatDate(device.customer.portalPasswordUpdatedAt) })
                      : t('detail.portalPassword.autoGenerated')}
                  </p>
                </div>
              )}
              {device.customer?.accountId && device.customer?.customerId && (
                <CustomerLgpd
                  accountId={device.customer.accountId}
                  customerId={device.customer.customerId}
                />
              )}
              <div className="mt-5 border-t border-border pt-4">
                <label htmlFor="installation-date" className="field-label">{t('detail.customer.installationDate')}</label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id="installation-date"
                    type="date"
                    className="modern-input"
                    value={installationDate}
                    onChange={(event) => setInstallationDate(event.target.value)}
                  />
                  <button
                    type="button"
                    className="modern-button shrink-0"
                    disabled={savingInstallationDate}
                    onClick={() => void handleSaveInstallationDate()}
                  >
                    {savingInstallationDate ? t('detail.customer.savingDate') : t('detail.customer.saveDate')}
                  </button>
                </div>
                <p className="field-hint">{t('detail.customer.dateHint')}</p>
              </div>
            </div>

            {sgpAvailable && (
              <div className="modern-card p-5 sm:p-6 lg:col-span-2">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="page-kicker">{t('detail.sgp.kicker')}</p>
                    <h2 className="section-heading">{t('detail.sgp.title')}</h2>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="modern-button-secondary"
                      disabled={sgpLoading}
                      onClick={() => void loadSgpData(true)}
                    >
                      <Icon name="refresh" size={16} className="me-2" />
                      {sgpLoading ? t('detail.sgp.refreshing') : t('detail.sgp.refresh')}
                    </button>
                    {sgpLink && (
                      <>
                        <button
                          type="button"
                          className="modern-button"
                          disabled={sgpUnlocking}
                          onClick={() => void handleSgpUnlock()}
                        >
                          {sgpUnlocking ? t('detail.sgp.unlocking') : t('detail.sgp.unlock')}
                        </button>
                        {sgpTicketEnabled && (
                          <button
                            type="button"
                            className="modern-button-secondary"
                            onClick={toggleTicket}
                          >
                            <Icon name="chat" size={16} className="me-2" />
                            {t('detail.sgp.ticket')}
                          </button>
                        )}
                        <button
                          type="button"
                          className="modern-button-secondary"
                          onClick={() => void handleSgpUnlink()}
                        >
                          {t('detail.sgp.unlink')}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {sgpLink && sgpTicketEnabled && ticketOpen && (
                  <div
                    ref={ticketFormRef}
                    className="mt-4 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4"
                  >
                    <label className="metric-label" htmlFor="sgp-ticket-text">
                      {t('detail.sgp.ticketLabel')}
                    </label>
                    <textarea
                      id="sgp-ticket-text"
                      className="modern-input mt-2 min-h-24 w-full"
                      value={ticketText}
                      maxLength={4000}
                      onChange={(event) => setTicketText(event.target.value)}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('detail.sgp.ticketHint', { contract: sgpLink.contract })}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="modern-button"
                        disabled={ticketSending || !ticketText.trim()}
                        onClick={() => void handleOpenTicket()}
                      >
                        {ticketSending ? t('detail.sgp.ticketSending') : t('detail.sgp.ticketSend')}
                      </button>
                      <button
                        type="button"
                        className="modern-button-secondary"
                        disabled={ticketSending}
                        onClick={() => setTicketOpen(false)}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}

                {sgpLink ? (
                  <>
                    <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <p className="metric-label">{t('detail.sgp.contract')}</p>
                        <p className="mt-1 font-mono font-semibold">{sgpLink.contract}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="metric-label">{t('detail.sgp.client')}</p>
                        <p className="mt-1 font-semibold wrap-anywhere"><ClientName link={sgpLink} canOpen={canOpenContact} /></p>
                      </div>
                      <div className="min-w-0">
                        <p className="metric-label">{t('detail.sgp.plan')}</p>
                        <p className="mt-1 font-semibold wrap-anywhere">{sgpLink.plan || '—'}</p>
                      </div>
                      <div>
                        <p className="metric-label">{t('detail.sgp.status')}</p>
                        <p className="mt-1">
                          {/* O MESMO selo da faixa lá de cima. A mesma tela dando
                              duas respostas sobre o mesmo contrato é o defeito
                              que só aparece quando alguém compara. */}
                          <span className={selo.className}>
                            {selo.text ?? t(selo.fallbackKey)}
                          </span>
                        </p>
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground wrap-anywhere">
                      {t(sgpLink.linkMode === 'manual' ? 'detail.sgp.linkManual' : 'detail.sgp.linkAuto')}
                      {sgpLink.login ? ` · ${t('detail.sgp.linkLogin', { login: sgpLink.login })}` : ''}
                      {sgpLink.lastSyncedAt
                        ? ` · ${t('detail.sgp.linkSynced', { time: formatDateTime(sgpLink.lastSyncedAt) })}`
                        : ''}
                    </p>

                    <div className="mt-5 border-t border-border pt-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h3 className="font-semibold">{t('detail.sgp.invoicesTitle')}</h3>
                        {sgpInvoices.length > 0 && (
                          <FilterRail
                            value={invoiceFilter}
                            onChange={setInvoiceFilter}
                            ariaLabel={t('detail.sgp.invoiceFilterAria')}
                            // Quatro botões não cabem na largura de um celular:
                            // quebram em duas linhas em vez de rolar de lado e
                            // esconder "Todos".
                            className="flex-wrap"
                            options={[
                              { value: 'open', label: t('detail.sgp.invoiceFilterOpen', { count: invoiceCounts.open }) },
                              { value: 'cancelled', label: t('detail.sgp.invoiceFilterCancelled', { count: invoiceCounts.cancelled }) },
                              { value: 'other', label: t('detail.sgp.invoiceFilterOther', { count: invoiceCounts.other }) },
                              { value: 'all', label: t('detail.sgp.invoiceFilterAll', { count: invoiceCounts.all }) },
                            ]}
                          />
                        )}
                      </div>
                      {sgpMessage && (
                        <p className="mt-2 text-sm text-[hsl(var(--status-warning))]">{sgpMessage}</p>
                      )}
                      {sgpInvoices.length === 0 ? (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {t(sgpMessage ? 'detail.sgp.invoicesUnavailable' : 'detail.sgp.noInvoices')}
                        </p>
                      ) : visibleInvoices.length === 0 ? (
                        <p className="mt-3 text-sm text-muted-foreground">{t('detail.sgp.invoiceFilterEmpty')}</p>
                      ) : (
                        <ul className="mt-3 space-y-3">
                          {visibleInvoices.map((invoice, index) => (
                            <li
                              key={invoice.id || `${invoice.dueDate}-${index}`}
                              className="rounded-md border border-border p-4"
                            >
                              <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <span className="font-semibold">{formatBrl(invoice.amount, intlLocale)}</span>
                                <span className="text-sm text-muted-foreground">
                                  {t('detail.sgp.dueOn', { date: invoiceDueDate(invoice.dueDate) })}
                                </span>
                              </div>
                              <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">
                                {invoice.description || t('detail.sgp.invoiceFallback')}
                                {invoice.status ? ` · ${invoice.status}` : ''}
                              </p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {invoice.digitableLine && (
                                  <button
                                    type="button"
                                    className="modern-button-secondary"
                                    onClick={async () => {
                                      const copied = await copyToClipboard(invoice.digitableLine as string)
                                      toast[copied ? 'success' : 'error'](
                                        t(copied ? 'detail.sgp.copiedLine' : 'detail.sgp.copyFailed')
                                      )
                                    }}
                                  >
                                    {t('detail.sgp.copyLine')}
                                  </button>
                                )}
                                {invoice.pix && (
                                  <button
                                    type="button"
                                    className="modern-button-secondary"
                                    onClick={async () => {
                                      const copied = await copyToClipboard(invoice.pix as string)
                                      toast[copied ? 'success' : 'error'](
                                        t(copied ? 'detail.sgp.copiedPix' : 'detail.sgp.copyFailed')
                                      )
                                    }}
                                  >
                                    {t('detail.sgp.copyPix')}
                                  </button>
                                )}
                                {isSafeExternalUrl(invoice.link) && (
                                  <a
                                    className="modern-button-secondary"
                                    href={invoice.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {t('detail.sgp.openBoleto')}
                                  </a>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="mt-5">
                    <p className="text-sm text-muted-foreground">
                      {sgpMessage || t('detail.sgp.notLinked')}
                    </p>
                    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        className="modern-input sm:max-w-xs"
                        placeholder={t('detail.sgp.contractPlaceholder')}
                        value={sgpContractInput}
                        onChange={(event) => setSgpContractInput(event.target.value)}
                      />
                      <button
                        type="button"
                        className="modern-button shrink-0"
                        disabled={sgpLoading}
                        onClick={() => void handleSgpLink()}
                      >
                        {t('detail.sgp.link')}
                      </button>
                    </div>
                    <p className="field-hint">{t('detail.sgp.linkHint')}</p>
                  </div>
                )}
              </div>
            )}

            {sgpAvailable && (
              <ProvisioningCard deviceId={deviceId} />
            )}

            <DeviceSwapsCard deviceId={deviceId} />

            {canWriteDevice && <DeviceDiagnosticsCard deviceId={deviceId} />}

            {canMaintainDevice && <DeviceFirmwareCard deviceId={deviceId} />}

            <DeviceHistoryCard deviceId={deviceId} />

            <div className="modern-card p-5 sm:p-6">
              <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">{t('detail.signalInfo.title')}</h2>
              <div className="space-y-3">
                 <div className={KV_ROW}>
                    <span className="text-gray-600 dark:text-gray-400">{t('detail.signalInfo.rxPower')}:</span>
                    <span className={`font-medium ${signalInfo.color}`}>
                      {vp.rxpower?.value !== null && vp.rxpower?.value !== undefined ? `${vp.rxpower.value} dBm` : t('common.na')}
                    </span>
                  </div>
                  <div className={KV_ROW}>
                    <span className="text-gray-600 dark:text-gray-400">{t('detail.signalInfo.temperature')}:</span>
                    <span className="font-medium">{vp.temperature?.value ?? t('common.na')}</span>
                  </div>
                  <div className={KV_ROW}>
                    <span className="text-gray-600 dark:text-gray-400">{t('detail.signalInfo.connectionStatus')}:</span>
                    {primaryWAN ? getStatusBadge(primaryWAN.status || 'Disconnected') : <span className="modern-badge">{t('common.na')}</span>}
                  </div>
                </div>
            </div>
          </div>
        )}

        {/* Tab WAN */}
        {activeTab === 'wan' && (
          <div className="modern-card p-5 sm:p-6">
            <div className="mb-5 flex flex-col gap-4 border-b border-border pb-5 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <h2 className="section-heading">{t('detail.wan.title')}</h2>
                <p className="section-description">{t('detail.wan.description')}</p>
              </div>
              {canWriteDevice && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(15rem,1fr)_8rem_auto]">
                  <div className="min-w-0">
                    <label htmlFor="wan-container" className="field-label">{t('detail.wan.container')}</label>
                    <select id="wan-container" className="modern-input max-w-full" value={wanContainer}
                      onChange={(event) => setWanContainer(event.target.value)}>
                      {(device.wanContainers || []).map((container) => (
                        <option key={container.path} value={container.path}>{container.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="wan-type" className="field-label">{t('detail.wan.type')}</label>
                    <select id="wan-type" className="modern-input" value={newWanType}
                      onChange={(event) => setNewWanType(event.target.value as 'ppp' | 'ip')}>
                      <option value="ppp">PPPoE</option>
                      <option value="ip">IP</option>
                    </select>
                  </div>
                  <button type="button" className="modern-button self-end" disabled={addingWan || !wanContainer}
                    onClick={() => void handleAddWan()}>
                    {addingWan ? t('detail.wan.queuing') : t('detail.wan.add')}
                  </button>
                </div>
              )}
            </div>
            <div className="space-y-6">
              {device.wan && device.wan.length > 0 ? (
                device.wan.map((wan) => (
                  <div key={wan.index} className="flex flex-col border border-gray-200 dark:border-gray-700 rounded-md">
                    <div className="p-5 space-y-3">
                      <div className="flex justify-between items-start gap-3">
                        <h3 className="min-w-0 text-md font-semibold text-gray-900 dark:text-gray-100 wrap-anywhere">
                          {wan.name || t('detail.wan.connection', { index: wan.index })}
                        </h3>
                        <span className="shrink-0">{getStatusBadge(wan.status || 'Disconnected')}</span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                        <div className="space-y-3">
                          <div className={KV_ROW}>
                            <span className="text-gray-600 dark:text-gray-400">{t('detail.wan.vlanId')}:</span>
                            <span className="font-medium">
                              { (wan.vlanId === null || wan.vlanId === undefined) ? (
                                <span className="px-2 py-0.5 rounded-md bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs">
                                  {t('detail.wan.notSet')}
                                </span>
                              ) : (
                                String(wan.vlanId)
                              )}
                            </span>
                          </div>
                          <div className={KV_ROW}>
                            <span className="text-gray-600 dark:text-gray-400">{t('detail.wan.username')}:</span>
                            <span className="font-mono text-sm">{wan.username || t('common.na')}</span>
                          </div>
                          <div className={KV_ROW}>
                            <span className="text-gray-600 dark:text-gray-400">{t('detail.wan.ipAddress')}:</span>
                            <span className="font-mono text-sm">{wan.ipAddress || t('common.na')}</span>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <div className={KV_ROW}>
                            <span className="text-gray-600 dark:text-gray-400">{t('detail.wan.service')}:</span>
                            <span className="font-medium">
                            { (wan.serviceList === null || wan.serviceList === undefined) ? (
                                <span className="px-2 py-0.5 rounded-md bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs">
                                  {t('detail.wan.notSet')}
                                </span>
                              ) : (
                                wan.serviceList
                              )}
                            </span>
                          </div>
                          <div className={KV_ROW}>
                            <span className="text-gray-600 dark:text-gray-400">{t('detail.wan.connectionType')}:</span>
                            <span className="font-medium">{wan.connectionType || t('common.na')}</span>
                          </div>
                          <div className={KV_ROW}>
                            <span className="text-gray-600 dark:text-gray-400">{t('detail.wan.nat')}:</span>
                            <span className="font-medium">
                              { (wan.natEnabled === null || wan.natEnabled === undefined) ? t('common.na') : (
                                wan.natEnabled ? t('common.enabled') : t('common.disabled')
                              )}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Visual Interface Binding */}
                      {wan.bindings && (wan.bindings.lan.length > 0 || wan.bindings.ssid.length > 0) ? (
                        <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                          <h4 className="flex items-center text-md font-semibold mb-4 text-gray-900 dark:text-gray-100">
                            <svg className="w-5 h-5 me-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.135a4 4 0 000-5.656l-4-4a4 4 0 00-5.656 0zm0 0L9.5 7.5"></path>
                            </svg>
                            {t('detail.wan.bindings')}
                          </h4>

                          {/* LAN Ports */}
                          <div className="mb-4">
                            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('detail.wan.lanPorts')}</p>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                              {[1, 2, 3, 4].map(i => (
                                <div key={`lan-${i}`} className="flex-1 min-w-[80px]">
                                  {renderBindingBox(`LAN${i}`, wan.bindings?.lan.includes(`LAN${i}`) || false)}
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* WiFi Networks */}
                          <div>
                            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('detail.wan.wifiNetworks')}</p>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                              {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                                <div key={`ssid-${i}`} className="flex-1 min-w-[80px]">
                                  {renderBindingBox(`SSID${i}`, wan.bindings?.ssid.includes(`SSID${i}`) || false)}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : wan.bindings ? (
                        <div className="mt-4 pt-3 border-t border-gray-200 dark:border-gray-700">
                          <h4 className="flex items-center text-md font-semibold text-gray-900 dark:text-gray-100 mb-2">
                            <svg className="w-5 h-5 me-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.135a4 4 0 000-5.656l-4-4a4 4 0 00-5.656 0zm0 0L9.5 7.5"></path>
                            </svg>
                            {t('detail.wan.bindings')}
                          </h4>
                          <span className="text-gray-500 dark:text-gray-400 text-sm">{t('detail.wan.noBindings')}</span>
                        </div>
                      ) : null}
                    </div>
                    <div className="px-5 pb-5 pt-2">
                      {wan.editable ? (
                        <button
                          onClick={() => handleOpenEditModal(wan)}
                          className="w-full modern-button-secondary flex items-center justify-center space-x-2"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                          </svg>
                          <span>{t('detail.wan.edit')}</span>
                        </button>
                      ) : (
                        <p className="text-center text-xs text-gray-500 dark:text-gray-400">
                          {t('detail.wan.onlyPppoe')}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-gray-500 dark:text-gray-400">{t('detail.wan.empty')}</p>
              )}
            </div>
          </div>
        )}

        {activeTab === 'clients' && (
          <div className="modern-card overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="section-heading">{t('detail.clients.title')}</h2>
                <p className="section-description">{t('detail.clients.description')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="modern-badge-success">{t('detail.clients.onlineCount', { count: device.clients?.filter((client) => client.active === true).length || 0 })}</span>
                <span className="modern-badge">{t('detail.clients.offlineCount', { count: device.clients?.filter((client) => client.active === false).length || 0 })}</span>
              </div>
            </div>
            {device.clients?.length ? (
              <>
                <div className="grid gap-3 p-4 md:hidden">
                  {device.clients.map((client) => (
                    <article key={`${client.dataModel}-${client.instance}-${client.macAddress || client.ipAddress || ''}`} className="min-w-0 rounded-md border border-border p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate font-semibold">{client.hostName || t('detail.clients.unnamed')}</h3>
                          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{client.macAddress || t('detail.clients.macNotReported')}</p>
                        </div>
                        <span className={`shrink-0 ${client.active === true ? 'modern-badge-success' : client.active === false ? 'modern-badge' : 'modern-badge-warning'}`}>
                          {client.active === true ? t('detail.status.online') : client.active === false ? t('detail.status.offline') : t('common.unknown')}
                        </span>
                      </div>
                      <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-sm">
                        <div><dt className="text-xs text-muted-foreground">{t('detail.clients.ipAddress')}</dt><dd className="mt-1 break-all font-mono">{client.ipAddress || '—'}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">{t('detail.clients.interface')}</dt><dd className="mt-1 break-all">{client.interfaceType || '—'}</dd></div>
                      </dl>
                    </article>
                  ))}
                </div>
                <div className="hidden overflow-x-auto md:block">
                  <table className="modern-table">
                    <thead><tr><th>{t('common.status')}</th><th>{t('detail.clients.hostname')}</th><th>{t('detail.clients.ipAddress')}</th><th>{t('detail.clients.macAddress')}</th><th>{t('detail.clients.interface')}</th><th>{t('detail.clients.source')}</th></tr></thead>
                    <tbody>
                      {device.clients.map((client) => (
                        <tr key={`${client.dataModel}-${client.instance}-${client.macAddress || client.ipAddress || ''}`}>
                          <td><span className={client.active === true ? 'modern-badge-success' : client.active === false ? 'modern-badge' : 'modern-badge-warning'}>{client.active === true ? t('detail.status.online') : client.active === false ? t('detail.status.offline') : t('common.unknown')}</span></td>
                          <td className="font-semibold">{client.hostName || t('detail.clients.unnamed')}</td>
                          <td className="font-mono text-xs">{client.ipAddress || '—'}</td>
                          <td className="font-mono text-xs">{client.macAddress || '—'}</td>
                          <td>{client.interfaceType || '—'}</td>
                          <td>{client.addressSource || client.dataModel}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="empty-state">
                <div className="empty-state-icon"><Icon name="phone" size={22} /></div>
                <h3 className="empty-state-title">{t('detail.clients.emptyTitle')}</h3>
                <p className="empty-state-copy">{t('detail.clients.emptyCopy')}</p>
              </div>
            )}
          </div>
        )}

        {/* Tab WiFi */}
        {activeTab === 'wifi' && (
          <div className="modern-card p-5 sm:p-6">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="section-heading">{t('detail.wifi.title')}</h2>
                <p className="section-description mt-1">{t('detail.wifi.description')}</p>
              </div>
              {wifiNetworks.length > 0 && (
                <WifiStatusFilterControl value={wifiFilter} onChange={setWifiFilterChoice} counts={wifiCounts} />
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {wifiNetworks.length === 0 ? (
                <p className="text-gray-500 dark:text-gray-400 md:col-span-2">{t('detail.wifi.empty')}</p>
              ) : filteredWifi.length === 0 ? (
                <p className="text-gray-500 dark:text-gray-400 md:col-span-2">{t('detail.wifi.filterEmpty')}</p>
              ) : (
                filteredWifi.map((ssid) => (
                  <div key={ssid.index} className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-semibold text-foreground">{t('detail.wifi.ssidTitle', { index: ssid.index })}</h3>
                        <div className="mt-1 flex flex-wrap gap-2">
                          <span className={ssid.enable === false ? 'modern-badge-error' : ssid.enable === true ? 'modern-badge-success' : 'modern-badge'}>
                            {ssid.enable === false ? t('common.disabled') : ssid.enable === true ? t('common.enabled') : t('detail.wifi.unknownState')}
                          </span>
                          {ssid.usesVirtualParameters && <span className="modern-badge-info">{t('detail.wifi.installerVp')}</span>}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{t('detail.wifi.channelShort')} {ssid.channel ?? '—'}</span>
                    </div>
                    <dl className="space-y-3 text-sm">
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">{t('detail.wifi.networkName')}</dt>
                        <dd className="max-w-[65%] break-all text-end font-mono font-semibold">{ssid.ssid || t('detail.wifi.notReported')}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">{t('detail.wifi.password')}</dt>
                        {ssid.password ? (
                          <dd className="font-mono">••••••••</dd>
                        ) : (
                          // O GenieACS quase nunca tem a senha: os ONTs não a
                          // devolvem na leitura. "Não informado" soava como
                          // defeito; isto diz de quem é a lacuna e o que fazer.
                          <dd className="text-end text-muted-foreground" title={t('detail.wifi.passwordNotReportedHint')}>
                            {t('detail.wifi.passwordNotReported')}
                          </dd>
                        )}
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">{t('detail.wifi.security')}</dt>
                        <dd className="min-w-0 text-end wrap-anywhere">{ssid.security || t('detail.wifi.notReported')}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">{t('detail.wifi.associatedClients')}</dt>
                        <dd className="font-mono font-semibold">{ssid.totalAssociations ?? 0}</dd>
                      </div>
                    </dl>
                    {canWriteDevice ? (
                      <button type="button" onClick={() => setEditingWifi(ssid)} className="modern-button-secondary mt-5 w-full">
                        <Icon name="edit" size={17} /> {t('detail.wifi.edit', { index: ssid.index })}
                      </button>
                    ) : (
                      <p className="mt-4 text-xs text-muted-foreground">{t('detail.wifi.adminRequired')}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Tab Advanced */}
        {activeTab === 'advanced' && (
          <div className="modern-card p-5 sm:p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">{t('detail.advanced.title')}</h2>
            <div className="space-y-6">
              <div>
                <h3 className="text-md font-medium mb-3 text-gray-900 dark:text-gray-100">{t('detail.advanced.changeCredentials')}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
                    <h4 className="font-medium mb-2 text-gray-900 dark:text-gray-100">{t('detail.credentials.superadmin')}</h4>
                    <p className="text-sm text-gray-500 wrap-anywhere">{t('detail.advanced.user')}: {vp.superAdmin?.value || t('common.na')}</p>
                    <p className="text-sm text-gray-500">{t('detail.advanced.pass')}: {vp.superPassword?.value ? '******' : t('common.na')}</p>
                    <button
                      onClick={() => handleOpenCredentialModal('super')}
                      className="modern-button mt-3"
                    >
                      {t('detail.advanced.updateSuperadmin')}
                    </button>
                  </div>
                  <div className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
                    <h4 className="font-medium mb-2 text-gray-900 dark:text-gray-100">{t('detail.credentials.useradmin')}</h4>
                    <p className="text-sm text-gray-500 wrap-anywhere">{t('detail.advanced.user')}: {vp.userAdmin?.value || t('common.na')}</p>
                    <p className="text-sm text-gray-500">{t('detail.advanced.pass')}: {vp.userPassword?.value ? '******' : t('common.na')}</p>
                    <button
                      onClick={() => handleOpenCredentialModal('user')}
                      className="modern-button mt-3"
                    >
                      {t('detail.advanced.updateUseradmin')}
                    </button>
                  </div>
                </div>
              </div>

              <DeviceParametersCard deviceId={deviceId} />

              {/* <div>
                <h3 className="text-md font-medium mb-3 text-gray-900 dark:text-gray-100">Raw Device Data (Debug)</h3>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-md p-4">
                  <pre className="text-xs overflow-x-auto">
                    {JSON.stringify(device._raw || device, null, 2)}
                  </pre>
                </div>
              </div> */}
            </div>
          </div>
        )}
        <EditWanModal
          isOpen={isWanModalOpen}
          onClose={handleCloseWanModal}
          wanData={editingWan}
          onSave={handleSaveWan}
        />
        <EditCredentialModal
          isOpen={isCredentialModalOpen}
          onClose={handleCloseCredentialModal}
          credentialType={credentialType}
          username={
            credentialType === 'super' ? (vp.superAdmin?.value || t('common.na')) :
            credentialType === 'user' ? (vp.userAdmin?.value || t('common.na')) :
            ''
          }
          onSave={handleSaveCredentials}
        />
        <IrreversibleActionModal
          action={irreversibleAction}
          isOpen={irreversibleAction !== null}
          onClose={() => setIrreversibleAction(null)}
          deviceId={deviceId}
          serial={deviceInfo?.serialNumber || null}
          lastInform={device._lastInform || null}
          provisioningAvailable={sgpAvailable}
          onDone={(done) => {
            setIrreversibleAction(null)
            // A página de um aparelho que o ACS já não conhece não tem o que mostrar.
            if (done === 'remove') navigate('/devices')
          }}
        />
        <EditWifiModal
          wifi={editingWifi}
          onClose={() => setEditingWifi(null)}
          onSave={handleSaveWifi}
          saving={savingWifi}
        />
      </div>
    </div>
  )
}

/** The subscriber's name, a link to their client record when the operator may open it. */
function ClientName({ link, canOpen }: { link: SgpContractLink; canOpen: boolean }) {
  if (!link.clientName) return <>—</>
  if (!canOpen || !link.contract) return <>{link.clientName}</>
  return (
    <Link className="py-2.5 text-primary hover:underline sm:py-0" to={`/contacts/${encodeURIComponent(link.contract)}`}>
      {link.clientName}
    </Link>
  )
}
