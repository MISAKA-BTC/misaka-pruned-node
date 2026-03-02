module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  testTimeout: 30000,
  transformIgnorePatterns: [
    '/node_modules/(?!@noble/)',
  ],
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', {
      tsconfig: {
        allowJs: true,
        module: 'commonjs',
        esModuleInterop: true,
        target: 'ES2022',
      },
    }],
  },
};
