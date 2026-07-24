'use client'

import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useToast } from '@/components/ui/toast'
import { useLoading } from '@/components/ui/loading'
import { devicesAPI } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'

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
  vlanConfigurable?: boolean;
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
  };
  virtualParameters: {
    [key: string]: { path: string; value: any }
  };
  wifi: WifiNetwork[];
  wan: Array<WanConnection>;
  _raw?: any;
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
  vlanEnabled: boolean;
  vlanId: string;
  username: string;
  password: string;
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
    vlanEnabled: false,
    vlanId: '',
    username: '',
    password: '',
    bindings: {
      LAN1: false, LAN2: false, LAN3: false, LAN4: false,
      SSID1: false, SSID2: false, SSID3: false, SSID4: false,
      SSID5: false, SSID6: false, SSID7: false, SSID8: false,
    }
  });

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
        vlanEnabled: isVlanSet,
        vlanId: isVlanSet ? String(wanData.vlanId) : '',
        username: wanData.username || '',
        password: '',
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
    <div className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="wan-dialog-title">
      <div className="modern-card flex max-h-[90vh] w-full max-w-2xl flex-col">
        {/* Header Modal */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <h3 id="wan-dialog-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Edit WAN Connection
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>

        {/* Form Body */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {/* 1. WAN Name (Readonly) */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">WAN Name</label>
            <input
              type="text"
              value={wanData.name || 'N/A'}
              readOnly
              className="modern-input w-full bg-gray-100 dark:bg-gray-800 cursor-not-allowed"
            />
          </div>

          {/* 2. VLAN */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">VLAN</label>
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
                Enable VLAN
              </label>
            </div>
            <input
              type="number"
              min={1}
              max={4094}
              value={wanForm.vlanId}
              onChange={(e) => setWanForm(f => ({ ...f, vlanId: e.target.value }))}
              disabled={!wanForm.vlanEnabled}
              placeholder={!isVlanConfigurable ? 'VLAN Not Available' : (wanForm.vlanEnabled ? 'Enter VLAN ID (1-4094)' : 'VLAN Not Enabled')}
              className="modern-input w-full mt-2"
            />
          </div>

          {/* 3. PPP Username */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">PPP Username</label>
            <input
              type="text"
              value={wanForm.username}
              onChange={(e) => setWanForm(f => ({ ...f, username: e.target.value }))}
              className="modern-input w-full font-mono"
            />
          </div>

          {/* 4. PPP Password */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">PPP Password</label>
            <input
              type="password"
              value={wanForm.password}
              onChange={(e) => setWanForm(f => ({ ...f, password: e.target.value }))}
              placeholder="Enter new password (leave blank to keep unchanged)"
              className="modern-input w-full font-mono"
            />
          </div>

          {/* 5. Interface Binding */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Interface Binding</label>
            {!wanData.bindingsConfigurable && (
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                Binding parameters are not configured for this vendor.
              </p>
            )}
            <div className="space-y-4">
              {/* LAN */}
              <div>
                <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">LAN Ports</p>
                <div className="grid grid-cols-4 gap-3">
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
                <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">WiFi Networks</p>
                <div className="grid grid-cols-4 gap-3">
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
        <div className="flex items-center justify-end p-5 space-x-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="modern-button-secondary"
          >
            Cancel
          </button>
          <button
            onClick={handleSaveClick}
            className="modern-button"
          >
            Save Changes
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
  const [password, setPassword] = useState('');

  const handleSaveClick = () => {
    if (credentialType && password) {
      onSave(credentialType, password);
      setPassword('');
    }
  };

  const title = credentialType === 'super' ? 'Superadmin (ISP)' : 'Useradmin (Client)';

  if (!isOpen || !credentialType) return null;

  return (
    <div className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="credential-dialog-title">
      <div className="modern-card w-full max-w-md">
        {/* Header Modal */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <h3 id="credential-dialog-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Update {title}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>

        {/* Form Body */}
        <div className="p-6 space-y-4">
           <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Username</label>
            <input
              type="text"
              value={username || 'N/A'}
              readOnly
              className="modern-input w-full bg-gray-100 dark:bg-gray-800 cursor-not-allowed"
            />
          </div>
           <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">New Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter new password"
              className="modern-input w-full font-mono"
            />
          </div>
        </div>

        {/* Footer Modal */}
        <div className="flex items-center justify-end p-5 space-x-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="modern-button-secondary"
          >
            Cancel
          </button>
          <button
            onClick={handleSaveClick}
            disabled={!password}
            className="modern-button"
          >
            Save Password
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
    <div className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="wifi-dialog-title">
      <div className="modern-card flex max-h-[92vh] w-full max-w-lg flex-col">
        <div className="flex items-start justify-between border-b border-border p-5">
          <div>
            <h3 id="wifi-dialog-title" className="section-heading">Edit WiFi SSID {wifi.index}</h3>
            <p className="section-description mt-1">
              {wifi.usesVirtualParameters ? 'Using genieacs-installer virtual parameters.' : 'Using the device TR-098 WLAN path.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="icon-button" aria-label="Close WiFi editor">
            <Icon name="x" size={19} />
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto p-5">
          <label className="flex min-h-11 items-center justify-between gap-4 rounded-md border border-border bg-[hsl(var(--surface-subtle))] px-4">
            <span>
              <span className="block text-sm font-semibold">Radio enabled</span>
              <span className="block text-xs text-muted-foreground">Applied only when the CPE exposes the Enable parameter.</span>
            </span>
            <input type="checkbox" checked={form.enable} onChange={(event) => setForm((current) => ({ ...current, enable: event.target.checked }))} />
          </label>
          <div>
            <label htmlFor="wifi-ssid" className="field-label">Network name (SSID)</label>
            <input id="wifi-ssid" className="modern-input w-full" maxLength={32} value={form.ssid}
              onChange={(event) => setForm((current) => ({ ...current, ssid: event.target.value }))} />
            <p className="field-hint">{form.ssid.length}/32 characters</p>
          </div>
          <div>
            <label htmlFor="wifi-password" className="field-label">New password</label>
            <input id="wifi-password" type="password" className="modern-input w-full font-mono" minLength={8} maxLength={63}
              value={form.password} placeholder="Leave blank to keep the existing password"
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} />
            <p className="field-hint">WPA/WPA2 passphrases require 8–63 characters.</p>
          </div>
          <div>
            <label htmlFor="wifi-security" className="field-label">Beacon/security type</label>
            <input id="wifi-security" className="modern-input w-full" list="wifi-security-options" value={form.security}
              onChange={(event) => setForm((current) => ({ ...current, security: event.target.value }))} />
            <datalist id="wifi-security-options">
              <option value="None" />
              <option value="Basic" />
              <option value="WPA" />
              <option value="11i" />
              <option value="WPAand11i" />
            </datalist>
            <p className="field-hint">The exact accepted value depends on the CPE firmware.</p>
          </div>
          <div>
            <label htmlFor="wifi-channel" className="field-label">Channel</label>
            <input id="wifi-channel" type="number" min={0} max={196} className="modern-input w-full"
              value={form.channel} placeholder="0 for automatic when supported"
              onChange={(event) => setForm((current) => ({ ...current, channel: event.target.value }))} />
          </div>
          <div className="rounded-md border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] p-4 text-sm">
            Updating the SSID, password, or security mode can disconnect every client currently using this network.
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border p-5">
          <button type="button" onClick={onClose} className="modern-button-secondary" disabled={saving}>Cancel</button>
          <button type="button" onClick={() => onSave(form)} className="modern-button" disabled={saving || !form.ssid.trim()}>
            {saving ? 'Queuing task…' : 'Apply WiFi changes'}
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
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')
  const [rebooting, setRebooting] = useState(false)
  const { user } = useAuth()
  const toast = useToast()
  const loadingCtl = useLoading()
  const [isWanModalOpen, setIsWanModalOpen] = useState(false)
  const [editingWan, setEditingWan] = useState<WanConnection | null>(null)
  const [isCredentialModalOpen, setIsCredentialModalOpen] = useState(false)
  const [credentialType, setCredentialType] = useState<'super' | 'user' | null>(null);
  const [editingWifi, setEditingWifi] = useState<WifiNetwork | null>(null)
  const [savingWifi, setSavingWifi] = useState(false)


  const handleOpenEditModal = (wan: WanConnection) => {
    setEditingWan(wan);
    setIsWanModalOpen(true);
  }

  const handleCloseWanModal = () => {
    setIsWanModalOpen(false);
    setEditingWan(null);
  }

  const handleSaveWan = async (formData: WanFormState) => {
    if (!editingWan) return;
    if (formData.vlanEnabled) {
      const vlanId = Number(formData.vlanId)
      if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
        toast.error('VLAN ID must be between 1 and 4094')
        return
      }
    }

    loadingCtl.show('Saving WAN changes...');
    try {
      const res = await devicesAPI.updateWanConfig(deviceId, editingWan.index, formData);

      if (res.success) {
        toast.success(res.message || 'WAN config updated!');
        handleCloseWanModal();

        setTimeout(() => {
          fetchDeviceDetails(true);
        }, 1500);

      } else {
        toast.error(res.message || 'Failed to update WAN config');
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to save WAN config');
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
    loadingCtl.show('Updating credentials...');
    try {
      const res = await devicesAPI.updateCredentials(deviceId, type, password);

      if (res.success) {
        toast.success(res.message || 'Credentials update task queued!');
        handleCloseCredentialModal();
        setTimeout(() => {
          fetchDeviceDetails(true);
        }, 1500);
      } else {
        toast.error(res.message || 'Failed to update credentials');
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to update credentials');
    } finally {
      loadingCtl.hide();
    }
  }

  const handleSaveWifi = async (formData: WifiFormState) => {
    if (!editingWifi) return
    if (formData.password && (formData.password.length < 8 || formData.password.length > 63)) {
      toast.error('WiFi password must contain 8 to 63 characters')
      return
    }
    setSavingWifi(true)
    loadingCtl.show(`Queuing WiFi SSID ${editingWifi.index} update…`)
    try {
      const res = await devicesAPI.updateWifiConfig(deviceId, editingWifi.index, formData)
      if (!res.success) {
        toast.error(res.message || 'Failed to update WiFi configuration')
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
      toast.success(res.message || 'WiFi update task queued')
      setEditingWifi(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update WiFi configuration')
    } finally {
      setSavingWifi(false)
      loadingCtl.hide()
    }
  }

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
        setDevice(res.data as ProcessedDeviceDetail)
      } else {
        toast.error(res.message || 'Failed to load device details')
        setDevice(null)
      }
    } catch (error) {
      console.error('Error fetching device details:', error)
      toast.error('Network error fetching device details')
    } finally {
      setLoading(false);
    }
  }, [deviceId, toast])

  useEffect(() => {
    fetchDeviceDetails(false);
  }, [fetchDeviceDetails]);

  const handleReboot = async () => {
    if (!window.confirm(`Reboot ${device?._id || deviceId}?\n\nThe subscriber connection may be unavailable while the device restarts. Existing configuration is preserved.`)) {
      return
    }
    setRebooting(true)
    loadingCtl.show('Sending reboot command...')
    try {
      const res = await devicesAPI.rebootDevice(deviceId)
      if (res.success) {
        toast.success('Device reboot command sent successfully!')
      } else {
        toast.error(res.message || 'Failed to send reboot command')
      }
    } catch {
      toast.error('Error sending reboot command')
    } finally {
      setRebooting(false)
      loadingCtl.hide()
    }
  }

  const handleSummon = async () => {
    loadingCtl.show('Summoning device...')
    try {
      const res = await devicesAPI.summonDevice(deviceId)
      if (res.success) {
        toast.success(res.message || 'Summon command sent!')
      } else {
        toast.error(res.message || 'Failed to send summon')
      }
    } catch {
      toast.error('Error sending summon command')
    } finally {
      loadingCtl.hide()
    }
  }

  const getSignalStrengthInfo = (rxPowerStr: string | number | null | undefined) => {
    const rxpower = parseFloat(String(rxPowerStr));

    if (isNaN(rxpower)) {
      return {
        color: 'text-gray-500 dark:text-gray-400',
        label: 'N/A',
        badgeClass: 'modern-badge'
      };
    }

    if (rxpower >= -21.99) {
      return {
        color: 'text-green-600 dark:text-green-400',
        label: 'Excellent',
        badgeClass: 'modern-badge-success'
      };
    }
    if (rxpower >= -24.99) {
      return {
        color: 'text-blue-600 dark:text-blue-400',
        label: 'Good',
        badgeClass: 'modern-badge-info'
      };
    }
    if (rxpower >= -26.99) {
      return {
        color: 'text-yellow-600 dark:text-yellow-400',
        label: 'Poor',
        badgeClass: 'modern-badge-warning'
      };
    }
    return {
      color: 'text-red-600 dark:text-red-400',
      label: 'Danger',
      badgeClass: 'modern-badge-error'
    };
  }

  const getStatusBadge = (status: string | undefined) => {
    if (!status) return <span className="modern-badge">Unknown</span>

    if (status.includes(':') || status.includes('Z')) {
       try {
         const lastSeen = new Date(status)
         if (Number.isNaN(lastSeen.getTime())) {
           return <span className="modern-badge">Invalid Date</span>
         }
         const now = new Date()
         const diffMinutes = Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60))

         if (diffMinutes < 10) {
           return <span className="modern-badge-success">Online</span>
         } else if (diffMinutes < 60) {
           return <span className="modern-badge-warning">Away</span>
         } else {
           return <span className="modern-badge-error">Offline</span>
         }
       } catch {
          return <span className="modern-badge">Invalid Date</span>
       }
    }

    switch (status.toLowerCase()) {
      case 'connected':
        return <span className="modern-badge-success">Connected</span>
      case 'disconnected':
        return <span className="modern-badge-error">Disconnected</span>
      case 'connecting':
        return <span className="modern-badge-warning">Connecting</span>
      case 'idle':
        return <span className="modern-badge-warning">Idle</span>
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

  if (!device) {
    return (
      <div className="page-shell">
        <div className="page-frame">
          <div className="modern-card empty-state">
            <div className="empty-state-icon"><Icon name="server" size={22} /></div>
            <h2 className="empty-state-title">Device could not be opened</h2>
            <p className="empty-state-copy">Perangkat mungkin sudah dihapus atau GenieACS tidak mengembalikan detailnya. Kembali ke inventory lalu cari ulang serial perangkat.</p>
            <button
              onClick={() => navigate('/devices')} className="modern-button mt-5"
            >
              Back to inventory
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

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <div className="mb-3">
              <button
                onClick={() => navigate('/devices')}
                className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
              >
                <Icon name="back" size={17} /> Device inventory
              </button>
            </div>
            <p className="page-kicker">Managed endpoint</p>
            <h1 className="page-title break-all">
              {deviceInfo.serialNumber || device._id}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {getStatusBadge(device._lastInform)}
              <span className="text-xs text-muted-foreground">
                Last Inform {formatDate(device._lastInform)}
              </span>
              <span className="max-w-full truncate font-mono text-[0.68rem] text-muted-foreground">{device._id}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleReboot}
              disabled={rebooting}
              className="modern-button-secondary"
            >
              <Icon name="power" size={17} />
              {rebooting ? 'Rebooting…' : 'Reboot device'}
            </button>
            <button
              onClick={handleSummon}
              className="modern-button inline-flex items-center gap-1.5"
              title="Summon Device"
            >
              <Icon name="bell" size={16} /> Request Inform
            </button>
          </div>
        </header>

        {/* Device Info Cards */}
        <div className="mb-6 grid grid-cols-2 overflow-hidden rounded-[var(--radius)] border border-border bg-card lg:grid-cols-4">
          <div className="border-b border-r border-border p-4 lg:border-b-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Signal Strength</span>
              <span className={signalInfo.badgeClass}>{signalInfo.label}</span>
            </div>
            <div className={`text-2xl font-bold ${signalInfo.color}`}>
              {vp.rxpower?.value !== null && vp.rxpower?.value !== undefined ? `${vp.rxpower.value} dBm` : 'N/A'}
            </div>
          </div>
          <div className="border-b border-border p-4 lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Temperature</span>
              <Icon name="thermometer" size={20} className="text-gray-400 dark:text-gray-500" />
            </div>
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {vp.temperature?.value ?? 'N/A'}
            </div>
          </div>
          <div className="border-r border-border p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Active Devices</span>
              <Icon name="phone" size={20} className="text-gray-400 dark:text-gray-500" />
            </div>
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {vp.activedevices?.value || 0}
            </div>
          </div>
          <div className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Model</span>
              <Icon name="server" size={20} className="text-gray-400 dark:text-gray-500" />
            </div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {deviceInfo.productclass || 'N/A'}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6">
          <div className="tab-rail" role="tablist" aria-label="Device details">
            <button
              onClick={() => setActiveTab('overview')}
              className="tab-button"
              data-active={activeTab === 'overview'}
              role="tab"
              aria-selected={activeTab === 'overview'}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab('wan')}
              className="tab-button"
              data-active={activeTab === 'wan'}
              role="tab"
              aria-selected={activeTab === 'wan'}
            >
              WAN
            </button>
            <button
              onClick={() => setActiveTab('wifi')}
              className="tab-button"
              data-active={activeTab === 'wifi'}
              role="tab"
              aria-selected={activeTab === 'wifi'}
            >
              WiFi
            </button>
            <button
              onClick={() => setActiveTab('advanced')}
              className="tab-button"
              data-active={activeTab === 'advanced'}
              role="tab"
              aria-selected={activeTab === 'advanced'}
            >
              Advanced
            </button>
          </div>
        </div>

        {/* Tab Overview */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="modern-card p-6">
              <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Device Information</h2>
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Device ID:</span>
                  <span className="font-mono text-sm">{device._id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Serial Number:</span>
                  <span className="font-mono text-sm">{deviceInfo.serialNumber || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Manufacturer:</span>
                  <span>{deviceInfo.manufacturer || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Product Class:</span>
                  <span>{deviceInfo.productclass || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Hardware Version:</span>
                  <span>{deviceInfo.hardwareVersion || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Software Version:</span>
                  <span>{deviceInfo.softwareVersion || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Last Boot:</span>
                  <span>{formatDate(device._lastBoot)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Last Registered:</span>
                  <span>{formatDate(device._registered)}</span>
                </div>
              </div>
            </div>

            <div className="modern-card p-6">
              <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Signal Information</h2>
              <div className="space-y-3">
                 <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">RX Power:</span>
                    <span className={`font-medium ${signalInfo.color}`}>
                      {vp.rxpower?.value !== null && vp.rxpower?.value !== undefined ? `${vp.rxpower.value} dBm` : 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Temperature:</span>
                    <span className="font-medium">{vp.temperature?.value ?? 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Connection Status:</span>
                    {primaryWAN ? getStatusBadge(primaryWAN.status || 'Disconnected') : <span className="modern-badge">N/A</span>}
                  </div>
                </div>
            </div>
          </div>
        )}

        {/* Tab WAN */}
        {activeTab === 'wan' && (
          <div className="modern-card p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">WAN Configuration</h2>
            <div className="space-y-6">
              {device.wan && device.wan.length > 0 ? (
                device.wan.map((wan) => (
                  <div key={wan.index} className="flex flex-col border border-gray-200 dark:border-gray-700 rounded-md">
                    <div className="p-5 space-y-3">
                      <div className="flex justify-between items-center">
                        <h3 className="text-md font-semibold text-gray-900 dark:text-gray-100">
                          {wan.name || `Connection ${wan.index}`}
                        </h3>
                        {getStatusBadge(wan.status || 'Disconnected')}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                        <div className="space-y-3">
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">VLAN ID:</span>
                            <span className="font-medium">
                              { (wan.vlanId === null || wan.vlanId === undefined) ? (
                                <span className="px-2 py-0.5 rounded-md bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs">
                                  not set
                                </span>
                              ) : (
                                String(wan.vlanId)
                              )}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Username:</span>
                            <span className="font-mono text-sm">{wan.username || 'N/A'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">IP Address:</span>
                            <span className="font-mono text-sm">{wan.ipAddress || 'N/A'}</span>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Service:</span>
                            <span className="font-medium">
                            { (wan.serviceList === null || wan.serviceList === undefined) ? (
                                <span className="px-2 py-0.5 rounded-md bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs">
                                  not set
                                </span>
                              ) : (
                                wan.serviceList
                              )}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Connection Type:</span>
                            <span className="font-medium">{wan.connectionType || 'N/A'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">NAT:</span>
                            <span className="font-medium">
                              { (wan.natEnabled === null || wan.natEnabled === undefined) ? 'N/A' : (
                                wan.natEnabled ? 'Enabled' : 'Disabled'
                              )}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Visual Interface Binding */}
                      {wan.bindings && (wan.bindings.lan.length > 0 || wan.bindings.ssid.length > 0) ? (
                        <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                          <h4 className="flex items-center text-md font-semibold mb-4 text-gray-900 dark:text-gray-100">
                            <svg className="w-5 h-5 mr-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.135a4 4 0 000-5.656l-4-4a4 4 0 00-5.656 0zm0 0L9.5 7.5"></path>
                            </svg>
                            Interface Bindings
                          </h4>

                          {/* LAN Ports */}
                          <div className="mb-4">
                            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">LAN Ports</p>
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
                            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">WiFi Networks</p>
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
                            <svg className="w-5 h-5 mr-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.135a4 4 0 000-5.656l-4-4a4 4 0 00-5.656 0zm0 0L9.5 7.5"></path>
                            </svg>
                            Interface Bindings
                          </h4>
                          <span className="text-gray-500 dark:text-gray-400 text-sm">No active interface bindings found for this connection.</span>
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
                          <span>Edit WAN Connection</span>
                        </button>
                      ) : (
                        <p className="text-center text-xs text-gray-500 dark:text-gray-400">
                          Only PPPoE connections can be edited.
                        </p>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-gray-500 dark:text-gray-400">No WAN connection data found.</p>
              )}
            </div>
          </div>
        )}

        {/* Tab WiFi */}
        {activeTab === 'wifi' && (
          <div className="modern-card p-5 sm:p-6">
            <div className="mb-5">
              <h2 className="section-heading">WiFi configuration</h2>
              <p className="section-description mt-1">Review every reported WLAN instance and queue typed GenieACS configuration tasks.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {device.wifi && device.wifi.length > 0 ? (
                device.wifi.map((ssid) => (
                  <div key={ssid.index} className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-foreground">SSID {ssid.index}</h3>
                        <div className="mt-1 flex flex-wrap gap-2">
                          <span className={ssid.enable === false ? 'modern-badge-error' : ssid.enable === true ? 'modern-badge-success' : 'modern-badge'}>
                            {ssid.enable === false ? 'Disabled' : ssid.enable === true ? 'Enabled' : 'Unknown state'}
                          </span>
                          {ssid.usesVirtualParameters && <span className="modern-badge-info">Installer VP</span>}
                        </div>
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">CH {ssid.channel ?? '—'}</span>
                    </div>
                    <dl className="space-y-3 text-sm">
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Network name</dt>
                        <dd className="max-w-[65%] break-all text-right font-mono font-semibold">{ssid.ssid || 'Not reported'}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Password</dt>
                        <dd className="font-mono">{ssid.password ? '••••••••' : 'Not reported'}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Security</dt>
                        <dd className="text-right">{ssid.security || 'Not reported'}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Associated clients</dt>
                        <dd className="font-mono font-semibold">{ssid.totalAssociations ?? 0}</dd>
                      </div>
                    </dl>
                    {user?.role === 'admin' ? (
                      <button type="button" onClick={() => setEditingWifi(ssid)} className="modern-button-secondary mt-5 w-full">
                        <Icon name="edit" size={17} /> Edit SSID {ssid.index}
                      </button>
                    ) : (
                      <p className="mt-4 text-xs text-muted-foreground">Administrator access is required to change WiFi configuration.</p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-gray-500 dark:text-gray-400 md:col-span-2">No WiFi SSIDs reported.</p>
              )}
            </div>
          </div>
        )}

        {/* Tab Advanced */}
        {activeTab === 'advanced' && (
          <div className="modern-card p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Advanced Configuration</h2>
            <div className="space-y-6">
              <div>
                <h3 className="text-md font-medium mb-3 text-gray-900 dark:text-gray-100">Change Credentials</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
                    <h4 className="font-medium mb-2 text-gray-900 dark:text-gray-100">Superadmin (ISP)</h4>
                    <p className="text-sm text-gray-500">User: {vp.superAdmin?.value || 'N/A'}</p>
                    <p className="text-sm text-gray-500">Pass: {vp.superPassword?.value ? '******' : 'N/A'}</p>
                    <button
                      onClick={() => handleOpenCredentialModal('super')}
                      className="modern-button mt-3"
                    >
                      Update Superadmin
                    </button>
                  </div>
                  <div className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
                    <h4 className="font-medium mb-2 text-gray-900 dark:text-gray-100">Useradmin (Client)</h4>
                    <p className="text-sm text-gray-500">User: {vp.userAdmin?.value || 'N/A'}</p>
                    <p className="text-sm text-gray-500">Pass: {vp.userPassword?.value ? '******' : 'N/A'}</p>
                    <button
                      onClick={() => handleOpenCredentialModal('user')}
                      className="modern-button mt-3"
                    >
                      Update Useradmin
                    </button>
                  </div>
                </div>
              </div>

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
            credentialType === 'super' ? (vp.superAdmin?.value || 'N/A') :
            credentialType === 'user' ? (vp.userAdmin?.value || 'N/A') :
            ''
          }
          onSave={handleSaveCredentials}
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
