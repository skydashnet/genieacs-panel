const { spawn } = require('child_process');
const path = require('path');

// Check if Node.js is available
if (!process.version) {
  console.error('Node.js is not installed. Please install Node.js first.');
  process.exit(1);
}

console.log('🚀 Starting GenieACS Panel Frontend Development Server...');
console.log('📦 Project: GenieACS Panel - Luxury Network Management');
console.log('🎨 Design: Modern luxury UI with gradients and animations');
console.log('🛠  Tech: Next.js, TailwindCSS, React');

// Start Next.js development server
const nextDev = spawn('npx', ['next', 'dev'], {
  stdio: 'inherit',
  shell: true,
  cwd: __dirname
});

nextDev.on('close', (code) => {
  console.log(`Next.js dev server exited with code ${code}`);
});

nextDev.on('error', (err) => {
  console.error('Failed to start Next.js dev server:', err);
  process.exit(1);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down development server...');
  nextDev.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down development server...');
  nextDev.kill('SIGTERM');
});