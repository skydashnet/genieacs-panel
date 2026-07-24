import './globals.css'
import Sidebar from '@/components/sidebar'
import { ThemeProvider } from '@/contexts/theme-context'
import { AuthProvider } from '@/contexts/auth-context'
import { ToastProvider } from '@/components/ui/toast'
import { LoadingProvider, RouteChangeLoader } from '@/components/ui/loading'

export const metadata = {
  title: 'SkyGenPanel - GenieACS Network Management',
  description: 'Network device management panel for GenieACS',
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/icon.svg',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="id" suppressHydrationWarning={true}>
      <body className="bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200">
        <AuthProvider>
          <ThemeProvider>
            <LoadingProvider>
              <ToastProvider>
                <RouteChangeLoader />
                <div className="flex h-screen overflow-hidden">
                  <Sidebar />
                  <div className="flex-1 overflow-y-auto">
                    <div className="min-h-full flex flex-col">
                      <main className="flex-1">
                        {children}
                      </main>
                      <footer className="mt-auto px-6 py-3 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700">
                        © {new Date().getFullYear()} SkydashNET. All rights reserved.
                      </footer>
                    </div>
                  </div>
                </div>
              </ToastProvider>
            </LoadingProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
