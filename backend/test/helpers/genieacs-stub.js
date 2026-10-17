import http from 'node:http';

/** A parameter node in the shape GenieACS returns. */
function node(value, writable = true) {
  return { _value: value, _writable: writable, _timestamp: '2026-09-01T00:00:00.000Z' };
}

/**
 * A factory ONT with one PPPoE WAN and two WLAN configurations, close enough
 * to a real document that the vendor-aware parameter discovery in
 * `deviceService` takes its normal path.
 */
export function buildDevice({
  id = 'stub-device-1',
  pppoeUsername = 'joao@provedor',
  ssid = 'FACTORY-SSID',
  vlanId = 0,
  tags = [],
  lastInform = null,
  rxPower = -21.5,
  temperature = 42,
  upTime = 86_400
} = {}) {
  return {
    _id: id,
    _lastInform: lastInform ?? new Date().toISOString(),
    _registered: '2026-09-01T00:00:00.000Z',
    _tags: tags,
    _deviceId: {
      _Manufacturer: 'ZTE',
      _ProductClass: 'F670L',
      _SerialNumber: 'ZTEG12345678'
    },
    VirtualParameters: {
      PPPUsername: node(pppoeUsername, false),
      LoginSuperPass: node('factory', true),
      OpticalRXPower: node(rxPower, false),
      OpticalTemperature: node(temperature, false)
    },
    InternetGatewayDevice: {
      DeviceInfo: {
        SoftwareVersion: node('V1.0.0', false),
        SerialNumber: node('ZTEG12345678', false),
        UpTime: node(upTime, false)
      },
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: {
              WANPPPConnection: {
                1: {
                  Username: node(pppoeUsername),
                  Password: node(''),
                  Name: node('pppoe_1'),
                  ConnectionStatus: node('Connected', false),
                  NATEnabled: node(true),
                  'X_ZTE-COM_VLANID': node(vlanId),
                  'X_ZTE-COM_ServiceList': node('INTERNET')
                }
              }
            }
          }
        }
      },
      LANDevice: {
        1: {
          WLANConfiguration: {
            1: {
              Enable: node(true),
              SSID: node(ssid),
              BeaconType: node('11i'),
              PreSharedKey: { 1: { KeyPassphrase: node('') } }
            },
            5: {
              Enable: node(true),
              SSID: node(`${ssid}-5G`),
              BeaconType: node('11i'),
              PreSharedKey: { 1: { KeyPassphrase: node('') } }
            }
          }
        }
      }
    }
  };
}

/**
 * Minimal stand-in for a GenieACS NBI. It records every task and tag mutation
 * so a test can assert on what provisioning actually wrote, and `taskStatus`
 * lets a test simulate a CPE that only queues the task (202) rather than
 * applying it.
 *
 * `state.respond` is the escape hatch for tests about a hostile or broken NBI:
 * set it to a function and it answers every request instead of the routes
 * below, which is how a test makes this host reply 302 or leak a body. It is
 * on `state` rather than a constructor argument only so a test can switch the
 * behaviour on between requests.
 */
export function startGenieAcsStub({ devices = [buildDevice()], taskStatus = 200, respond = null } = {}) {
  // `onTask` é chamado a cada tarefa aceita com 200, com a tarefa e o estado:
  // é como um teste faz a ONT "responder" — mudar o documento que o ACS guarda.
  // Tarefa aceita com 202 fica em `GET /tasks`, que é a fila do ACS.
  // `files` é a coleção de arquivos do ACS (firmware), como o NBI a devolve.
  const state = { devices, tasks: [], tags: [], deleted: [], files: [], taskStatus, taskStatusFor: null, respond, requests: [], onTask: null };

  const server = http.createServer((req, res) => {
    // O corpo em bytes: um firmware enviado (`PUT /files/<nome>`) não é texto,
    // e juntá-lo como string corromperia todo byte que não é UTF-8 válido.
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const raw = bytes.toString('utf8');
      const url = new URL(req.url, 'http://stub');
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data ?? null));
      };
      // A credencial e o corpo também, para quem precisa provar que um pedido
      // chegou IGUAL por dois caminhos (o direto e o agente).
      state.requests.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        authorization: req.headers.authorization ?? null,
        contentType: req.headers['content-type'] ?? null,
        headers: { ...req.headers },
        body: raw,
        bytes
      });

      if (state.respond) return state.respond({ req, res, url, body: raw, send });

      const taskMatch = url.pathname.match(/^\/devices\/([^/]+)\/tasks$/);
      if (taskMatch && req.method === 'POST') {
        let task = null;
        try {
          task = JSON.parse(raw || '{}');
        } catch {
          task = null;
        }
        const deviceId = decodeURIComponent(taskMatch[1]);
        // `taskStatusFor` responde por aparelho: é como um teste faz UMA ONT
        // de um lote recusar enquanto as outras aceitam.
        const status = state.taskStatusFor?.(deviceId) ?? state.taskStatus;
        const entry = { deviceId, task, status, connectionRequest: url.searchParams.has('connection_request') };
        state.tasks.push(entry);
        if (status === 200 && state.onTask) state.onTask(entry, state);
        return send(status, status >= 400 ? { message: 'refused' } : task);
      }

      if ((url.pathname === '/files' || url.pathname === '/files/') && req.method === 'GET') {
        let filter = {};
        try {
          filter = JSON.parse(url.searchParams.get('query') || '{}');
        } catch {
          filter = {};
        }
        // `metadata.fileType` como valor, `_id` como valor ou `{ $regex }` (o
        // prefixo do dono num ACS compartilhado) e `$and` juntando — as formas
        // que o painel usa. `skip`/`limit` como o NBI: a ordem é a da lista.
        const casa = (file, f) => {
          if (Array.isArray(f.$and)) return f.$and.every((parte) => casa(file, parte || {}));
          if (f['metadata.fileType'] !== undefined && file.metadata?.fileType !== f['metadata.fileType']) return false;
          if (f._id !== undefined) {
            if (typeof f._id?.$regex === 'string') { if (!new RegExp(f._id.$regex).test(String(file._id))) return false; }
            else if (file._id !== f._id) return false;
          }
          return true;
        };
        const skip = Number(url.searchParams.get('skip') || 0);
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : Infinity;
        const achados = state.files.filter((file) => casa(file, filter));
        return send(200, achados.slice(skip, skip + limit));
      }

      // Um arquivo: o `PUT` grava (substituindo, como o GenieACS faz) com os
      // metadados dos quatro cabeçalhos; o `DELETE` apaga, 404 se não existe.
      const fileMatch = url.pathname.match(/^\/files\/([^/]+)$/);
      if (fileMatch && req.method === 'PUT') {
        const id = decodeURIComponent(fileMatch[1]);
        const meta = {};
        for (const [campo, cabecalho] of [['fileType', 'filetype'], ['oui', 'oui'], ['productClass', 'productclass'], ['version', 'version']]) {
          if (req.headers[cabecalho] !== undefined) meta[campo] = req.headers[cabecalho];
        }
        state.files = state.files.filter((file) => file._id !== id);
        state.files.push({ _id: id, length: bytes.length, uploadDate: new Date().toISOString(), metadata: meta });
        state.uploads = [...(state.uploads || []), { id, bytes, headers: { ...req.headers } }];
        res.writeHead(201);
        return res.end();
      }
      if (fileMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(fileMatch[1]);
        if (!state.files.some((file) => file._id === id)) return send(404, { message: 'not found' });
        state.files = state.files.filter((file) => file._id !== id);
        state.deletedFiles = [...(state.deletedFiles || []), id];
        res.writeHead(200);
        return res.end();
      }

      if (url.pathname === '/tasks' && req.method === 'GET') {
        let filter = {};
        try {
          filter = JSON.parse(url.searchParams.get('query') || '{}');
        } catch {
          filter = {};
        }
        return send(200, state.tasks
          .filter((entry) => entry.status === 202)
          .filter((entry) => !filter.device || entry.deviceId === filter.device)
          .map((entry, index) => ({ _id: `task-${index}`, device: entry.deviceId, name: entry.task?.name })));
      }

      const tagMatch = url.pathname.match(/^\/devices\/([^/]+)\/tags\/([^/]+)$/);
      if (tagMatch) {
        state.tags.push({
          deviceId: decodeURIComponent(tagMatch[1]),
          tag: decodeURIComponent(tagMatch[2]),
          method: req.method
        });
        return send(200, {});
      }

      const deviceMatch = url.pathname.match(/^\/devices\/([^/]+)$/);
      if (deviceMatch && req.method === 'DELETE') {
        state.deleted.push(decodeURIComponent(deviceMatch[1]));
        return send(200, {});
      }

      if (url.pathname === '/devices' || url.pathname === '/devices/') {
        const query = url.searchParams.get('query');
        if (!query) return send(200, state.devices);
        let filter = {};
        try {
          filter = JSON.parse(query);
        } catch {
          filter = {};
        }
        // `_id` como valor ou como `{ $in: [...] }`, `_tags` como valor (a tag do
        // provedor num ACS compartilhado) e `$and` juntando os dois — as formas
        // que o painel usa. O resto do filtro é ignorado, como sempre foi.
        const casa = (device, f) => {
          if (Array.isArray(f.$and)) return f.$and.every((parte) => casa(device, parte || {}));
          if (f._id !== undefined) {
            if (Array.isArray(f._id?.$in)) { if (!f._id.$in.includes(device._id)) return false; }
            else if (device._id !== f._id) return false;
          }
          if (f._tags !== undefined && !(device._tags || []).includes(f._tags)) return false;
          return true;
        };
        return send(200, state.devices.filter((device) => casa(device, filter)));
      }

      if (url.pathname === '/faults') return send(200, state.faults || []);
      const faultMatch = url.pathname.match(/^\/faults\/([^/]+)$/);
      if (faultMatch && req.method === 'DELETE') {
        state.deletedFaults = [...(state.deletedFaults || []), decodeURIComponent(faultMatch[1])];
        return send(200, {});
      }
      return send(404, { message: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

/** Every parameter path written across the recorded setParameterValues tasks. */
export function writtenParameters(state) {
  return state.tasks
    .filter((entry) => entry.task?.name === 'setParameterValues')
    .flatMap((entry) => entry.task.parameterValues || []);
}
