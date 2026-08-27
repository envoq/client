export type BrokerStatus = { connected: boolean; status: string; agents: number; messages: number; latency: number }

export async function getBrokerStatus(): Promise<BrokerStatus> {
  const base = process.env.ENVOQ_BROKER_URL
  if (!base) return { connected: false, status: 'Configuration required', agents: 0, messages: 0, latency: 0 }
  try {
    const headers = process.env.ENVOQ_API_KEY ? { authorization: `Bearer ${process.env.ENVOQ_API_KEY}` } : {}
    const response = await fetch(`${base.replace(/\/$/, '')}/health`, { headers, next: { revalidate: 15 } })
    if (!response.ok) throw new Error('Broker unavailable')
    const data = await response.json()
    return { connected: true, status: data.status ?? 'Operational', agents: data.agents ?? 0, messages: data.messages ?? 0, latency: data.latency ?? 0 }
  } catch { return { connected: false, status: 'Offline', agents: 0, messages: 0, latency: 0 } }
}
