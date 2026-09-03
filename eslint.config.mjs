import nextConfig from 'eslint-config-next';

const eslintConfig = [
  ...nextConfig,
  { ignores: ['storage/**', 'data/**', 'test/**'] },
];

export default eslintConfig;
