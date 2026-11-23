// Network (S-211): the one module of the composition root that names the runtime's fetch. The
// starters hand productFetch to the service and the backfill; nothing else reaches the network
// except the source clients, the push receiver and the release check.

export const productFetch = fetch;
