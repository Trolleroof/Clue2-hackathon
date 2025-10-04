const { defineConfig } = require('vitest/config');
const { react } = require('@vitejs/plugin-react');
const path = require('path');

module.exports = defineConfig({
    plugins: [react()],
    server: {
        watch: {
            usePolling: true
        }
    },
    test: {
        environment: 'node',
        include: ['src/__tests__/**/*.test.js'],
        globals: true,
        coverage: {
            reporter: ['text'],
        },
    },
    resolve: {
        alias: {
            electron: path.resolve(__dirname, 'src/__mocks__/electron.js'),
        },
    },
});
