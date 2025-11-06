# GenieACS Panel - Luxury Frontend

A modern, luxurious, and professional frontend for GenieACS network device management system.

## Features

### 🎨 Luxury Design System
- **Gradient Aesthetics**: Beautiful gold, ruby, sapphire, and emerald gradients
- **Glass Morphism**: Modern frosted glass effects with backdrop blur
- **Micro-interactions**: Smooth hover states, transitions, and animations
- **Professional Typography**: Clean, readable fonts with proper hierarchy
- **Responsive Design**: Fully responsive across all device sizes

### 📊 Dashboard
- **Real-time Metrics**: Live device statistics with trend indicators
- **Interactive Charts**: Connection history and device type distributions
- **Recent Activity**: Latest device provisioning and status changes
- **Quick Actions**: Fast access to common management tasks

### 🔧 Device Management
- **Advanced Search**: Filter by ID, serial, model, or status
- **Signal Monitoring**: Visual RX power and temperature indicators
- **Status Tracking**: Real-time online/offline status
- **Batch Operations**: Configure multiple devices simultaneously

### 🏭 Vendor Configuration
- **Vendor Profiles**: Support for Huawei, ZTE, FiberHome, and custom vendors
- **Parameter Mapping**: Dynamic parameter paths per vendor/device type
- **WiFi Security**: Comprehensive security type mappings
- **Priority Management**: Vendor priority and enable/disable controls

### ⚙️ System Settings
- **General Configuration**: App name, GenieACS URL settings
- **Virtual Parameters**: Custom virtual parameter definitions
- **Security Options**: Session timeout, 2FA authentication
- **Connection Testing**: Real-time GenieACS connectivity validation

## Technology Stack

- **Framework**: Next.js 14 with App Router
- **Styling**: TailwindCSS with custom luxury design system
- **Components**: Custom components with shadcn/ui patterns
- **Animations**: Framer Motion for smooth transitions
- **Icons**: Lucide React for consistent iconography
- **Charts**: Recharts for data visualization
- **State Management**: React hooks for local state
- **API Integration**: Axios for backend communication

## Getting Started

### Prerequisites
- Node.js 18+ 
- npm or yarn package manager

### Installation

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

### Environment Configuration

Create a `.env.local` file in the root directory:

```env
NEXT_PUBLIC_API_URL=http://localhost:1997/api
NEXT_PUBLIC_APP_NAME=GenieACS Panel
```

## Project Structure

```
frontend/
├── src/
│   ├── app/                    # Next.js App Router pages
│   │   ├── globals.css        # Global styles and luxury design system
│   │   ├── layout.jsx         # Root layout with navbar
│   │   ├── page.jsx           # Home page (redirects to dashboard)
│   │   ├── dashboard/         # Main dashboard page
│   │   ├── devices/           # Device management page
│   │   ├── vendors/           # Vendor configuration page
│   │   └── settings/          # System settings page
│   ├── components/
│   │   ├── ui/               # Reusable UI components
│   │   └── navbar.jsx         # Navigation component
│   ├── lib/
│   │   └── utils.ts           # Utility functions
│   └── types/
│       └── index.ts           # TypeScript type definitions
├── public/                     # Static assets
├── package.json               # Dependencies and scripts
├── tailwind.config.js         # TailwindCSS configuration
├── next.config.js            # Next.js configuration
└── README.md                 # This file
```

## Design System

### Color Palette
- **Gold** (#D4AF37): Primary accent and luxury feel
- **Ruby** (#E0115F): Secondary accent for important actions
- **Sapphire** (#0F52BA): Tertiary accent for information
- **Emerald** (#50C878): Success states and positive indicators
- **Platinum** (#E5E4E2): Backgrounds and subtle elements

### Typography
- **Headings**: Bold gradient text with luxury feel
- **Body**: Clean, readable sans-serif fonts
- **Code**: Monospace for technical data
- **UI Elements**: Medium weight for buttons and controls

### Components
- **Cards**: Glass morphism with hover effects
- **Buttons**: Gradient backgrounds with scale animations
- **Inputs**: Luxury styling with focus states
- **Tables**: Professional data presentation
- **Badges**: Status indicators with proper colors

## API Integration

The frontend is designed to work seamlessly with the GenieACS Panel backend:

### Authentication
- Login/logout functionality
- JWT token management
- Role-based access control

### Device Management
- CRUD operations for devices
- Real-time status updates
- Configuration management

### Vendor Management
- Dynamic vendor configuration
- Parameter mapping
- Security type definitions

### Dashboard Analytics
- Device metrics and statistics
- Connection history
- Performance monitoring

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Contributing

1. Follow the existing code style and patterns
2. Use the luxury design system consistently
3. Test across different screen sizes
4. Ensure accessibility standards are met

## License

This project is part of the GenieACS Panel ecosystem.