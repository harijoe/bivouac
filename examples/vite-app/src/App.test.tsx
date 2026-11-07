import { render, screen } from '@testing-library/react';
import { App } from './App';

test('renders the heading', () => {
  render(<App />);
  expect(screen.getByRole('heading')).toHaveTextContent('bivouac example app');
});
