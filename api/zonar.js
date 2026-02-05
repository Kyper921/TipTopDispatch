export default async function handler(req, res) {
  try {
    const {
      ZONAR_CUSTOMER,
      ZONAR_USERNAME,
      ZONAR_PASSWORD,
    } = process.env;

    if (!ZONAR_CUSTOMER || !ZONAR_USERNAME || !ZONAR_PASSWORD) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing Zonar credentials in environment." }));
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const operation = url.searchParams.get("operation");
    const target = url.searchParams.get("target");
    const starttime = url.searchParams.get("starttime");
    const endtime = url.searchParams.get("endtime");

    if (!operation || !target) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing required params: operation, target." }));
      return;
    }

    const isPath = operation === "path";
    const isCurrent = operation === "current";
    if (!isPath && !isCurrent) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid operation. Use 'path' or 'current'." }));
      return;
    }

    if (isPath && (!starttime || !endtime)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing required params for path: starttime, endtime." }));
      return;
    }

    const params = new URLSearchParams({
      customer: ZONAR_CUSTOMER,
      username: ZONAR_USERNAME,
      password: ZONAR_PASSWORD,
      action: "showposition",
      operation,
      format: isPath ? "json" : "xml",
      version: "2",
      logvers: isPath ? "3.8" : "3.1",
      reqtype: "fleet",
      target,
      type: "Standard",
      _cb: Date.now().toString(),
    });

    if (isPath) {
      params.set("starttime", starttime);
      params.set("endtime", endtime);
    }

    const zonarUrl = `https://omi.zonarsystems.net/interface.php?${params.toString()}`;
    const upstream = await fetch(zonarUrl, { cache: "no-store" });
    const body = await upstream.text();

    res.statusCode = upstream.status;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "text/plain"
    );
    res.end(body);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Proxy error", detail: String(err) }));
  }
}
