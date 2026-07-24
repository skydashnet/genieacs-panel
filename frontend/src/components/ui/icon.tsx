import React from 'react'
import {
  Squares2X2Icon,
  ServerStackIcon,
  MapIcon,
  Cog6ToothIcon,
  CheckCircleIcon,
  XMarkIcon,
  InformationCircleIcon,
  ExclamationTriangleIcon,
  BellIcon,
  ArrowPathIcon,
  ServerIcon,
  BuildingOffice2Icon,
  CubeIcon,
  HomeIcon,
  MapPinIcon,
  GlobeAltIcon,
  LockClosedIcon,
  PencilSquareIcon,
  TrashIcon,
  FireIcon,
  DevicePhoneMobileIcon,
  ChartBarIcon,
  SignalIcon,
  PowerIcon,
  ArrowLeftIcon,
  Bars3Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SunIcon,
  MoonIcon,
  ArrowRightStartOnRectangleIcon,
  MagnifyingGlassIcon,
  ArrowTopRightOnSquareIcon,
  WifiIcon,
  CircleStackIcon,
  CommandLineIcon,
  EyeIcon,
  EyeSlashIcon
} from '@heroicons/react/24/outline'

const ICONS: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  dashboard: Squares2X2Icon,
  devices: ServerStackIcon,
  map: MapIcon,
  settings: Cog6ToothIcon,
  check: CheckCircleIcon,
  x: XMarkIcon,
  info: InformationCircleIcon,
  warning: ExclamationTriangleIcon,
  bell: BellIcon,
  refresh: ArrowPathIcon,
  server: ServerIcon,
  building: BuildingOffice2Icon,
  box: CubeIcon,
  home: HomeIcon,
  pin: MapPinIcon,
  globe: GlobeAltIcon,
  lock: LockClosedIcon,
  edit: PencilSquareIcon,
  trash: TrashIcon,
  thermometer: FireIcon,
  phone: DevicePhoneMobileIcon,
  chart: ChartBarIcon,
  signal: SignalIcon,
  power: PowerIcon,
  back: ArrowLeftIcon,
  menu: Bars3Icon,
  'chevron-left': ChevronLeftIcon,
  'chevron-right': ChevronRightIcon,
  sun: SunIcon,
  moon: MoonIcon,
  logout: ArrowRightStartOnRectangleIcon,
  search: MagnifyingGlassIcon,
  external: ArrowTopRightOnSquareIcon,
  wifi: WifiIcon,
  database: CircleStackIcon,
  terminal: CommandLineIcon,
  eye: EyeIcon,
  'eye-off': EyeSlashIcon
}

interface IconProps extends React.SVGProps<SVGSVGElement> {
  name: keyof typeof ICONS | string
  size?: number
}

export function Icon({ name, size = 20, className = '', ...props }: IconProps) {
  const Cmp = ICONS[name] || InformationCircleIcon
  return <Cmp width={size} height={size} className={className} aria-hidden="true" {...props} />
}
