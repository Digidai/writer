// Lets tests import the Worker entry point: `cloudflare:workers` only
// exists in workerd, so resolve it to a tiny stub.
import { register } from 'node:module';

register(new URL('./loader.js', import.meta.url));
