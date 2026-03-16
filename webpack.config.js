import { createRequire } from 'module';
import webpack from 'webpack';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import Dotenv from 'dotenv-webpack';

const require = createRequire(import.meta.url);

export default (_, argv) => ({
  entry: {
    main: './app/main.ts',
  },
  target: 'web',
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        options: {
          allowTsInNodeModules: true,
          transpileOnly: true,
        },
      },
      {
        test: /\.svelte$/,
        loader: 'svelte-loader',
        options: {
          compilerOptions: {
            css: 'injected',
          },
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './app/index.html',
      filename: 'index.html',
      chunks: ['main'],
      scriptLoading: 'module',
    }),
    new Dotenv({ systemvars: true }),
    new webpack.ProvidePlugin({ Buffer: ['buffer', 'Buffer'] }),
  ],
  resolve: {
    extensions: ['.ts', '.js', '.svelte'],
    fallback: {
      tty: false,
      path: false,
      net: false,
      crypto: false,
      util: require.resolve('util/'),
      assert: require.resolve('assert/'),
      buffer: require.resolve('buffer/'),
    },
  },
  devServer: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    client: {
      overlay: false,
    },
    historyApiFallback: true,
    proxy: [
      {
        context: ['/api'],
        target: process.env.API_URL || 'http://localhost:3001',
        changeOrigin: true,
      },
    ],
  },
});
