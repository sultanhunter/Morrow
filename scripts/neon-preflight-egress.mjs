// Exact Neon1.2.0 WSS destination including its required PostgreSQL address.
export const neonPreflightEgressScript = `export default { async fetch(request, env) {
  const u = new URL(request.url);
  if (u.protocol !== 'https:' || u.hostname !== env.HOST || u.port ||
      u.pathname !== '/v2' || u.username || u.password ||
      [...u.searchParams.keys()].length !== 1 ||
      u.searchParams.get('address') !== env.HOST + ':5432')
    return new Response(null, {status:403});
  return fetch(request, {redirect:'manual'});
}};`;
