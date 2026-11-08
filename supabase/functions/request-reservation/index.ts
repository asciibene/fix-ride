const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ReservationRequest = {
  department: string;
  serviceDetails: string;
  date: string;
  time: string;
  name: string;
  phone: string;
  email: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requiredSecret(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required secret: ${name}`);
  }
  return value;
}

function normalizePhone(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) {
    return trimmed;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return null;
}

function validateReservation(input: unknown): ReservationRequest | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = input as Record<string, unknown>;
  const strings = ["department", "serviceDetails", "date", "time", "name", "phone", "email"];
  if (strings.some((key) => typeof value[key] !== "string")) {
    return null;
  }

  const request = value as ReservationRequest;
  request.department = request.department.trim();
  request.serviceDetails = request.serviceDetails.trim();
  request.date = request.date.trim();
  request.time = request.time.trim();
  request.name = request.name.trim();
  request.phone = request.phone.trim();
  request.email = request.email.trim();

  if (
    !["tech", "bike"].includes(request.department) ||
    request.serviceDetails.length < 1 ||
    request.serviceDetails.length > 500 ||
    request.name.length < 1 ||
    request.name.length > 100 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.email) ||
    request.email.length > 254 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(request.date) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(request.time) ||
    !normalizePhone(request.phone)
  ) {
    return null;
  }

  return request;
}

async function sendEmail(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!response.ok) {
    throw new Error(`Resend request failed with status ${response.status}`);
  }
}

async function sendSms(
  accountSid: string,
  authToken: string,
  from: string,
  to: string,
  body: string,
) {
  const credentials = btoa(`${accountSid}:${authToken}`);
  const params = new URLSearchParams({ From: from, To: to, Body: body });
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    },
  );
  if (!response.ok) {
    throw new Error(`Twilio request failed with status ${response.status}`);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let reservation: ReservationRequest | null;
  try {
    reservation = validateReservation(await request.json());
  } catch {
    return jsonResponse({ error: "Invalid reservation request" }, 400);
  }
  if (!reservation) {
    return jsonResponse({ error: "Invalid reservation details" }, 400);
  }

  const customerPhone = normalizePhone(reservation.phone);
  if (!customerPhone) {
    return jsonResponse({ error: "Invalid phone number" }, 400);
  }
  const businessPhone = normalizePhone(Deno.env.get("BUSINESS_PHONE") ?? "");
  if (!businessPhone) {
    return jsonResponse({ error: "Reservation notifications are not configured" }, 500);
  }

  let supabaseUrl: string;
  let serviceRoleKey: string;
  let resendApiKey: string;
  let emailFrom: string;
  let businessEmail: string;
  let twilioAccountSid: string;
  let twilioAuthToken: string;
  let twilioPhoneNumber: string;
  try {
    supabaseUrl = requiredSecret("SUPABASE_URL");
    serviceRoleKey = requiredSecret("SUPABASE_SERVICE_ROLE_KEY");
    resendApiKey = requiredSecret("RESEND_API_KEY");
    emailFrom = requiredSecret("EMAIL_FROM");
    businessEmail = requiredSecret("BUSINESS_EMAIL");
    twilioAccountSid = requiredSecret("TWILIO_ACCOUNT_SID");
    twilioAuthToken = requiredSecret("TWILIO_AUTH_TOKEN");
    twilioPhoneNumber = requiredSecret("TWILIO_PHONE_NUMBER");
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: "Reservation notifications are not configured" }, 500);
  }

  const departmentName = reservation.department === "tech"
    ? "Électronique & High-Tech"
    : "Cycles & Vélos";
  const dateAndTime = `${reservation.date} à ${reservation.time}`;

  let insertResponse: Response;
  try {
    insertResponse = await fetch(`${supabaseUrl}/rest/v1/reservations`, {
      method: "POST",
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        department: reservation.department,
        service_details: reservation.serviceDetails,
        requested_date: reservation.date,
        requested_time: reservation.time,
        customer_name: reservation.name,
        customer_phone: customerPhone,
        customer_email: reservation.email,
      }),
    });
  } catch (error) {
    console.error("Could not save reservation:", error);
    return jsonResponse({ error: "Could not save reservation" }, 502);
  }
  if (!insertResponse.ok) {
    console.error("Could not save reservation. Supabase status:", insertResponse.status);
    return jsonResponse({ error: "Could not save reservation" }, 502);
  }

  const insertedRows = await insertResponse.json();
  const reservationId = insertedRows[0]?.id;
  if (!reservationId) {
    console.error("Reservation insert returned no ID");
    return jsonResponse({ error: "Could not save reservation" }, 502);
  }

  const businessEmailText = [
    "Nouvelle demande de rendez-vous",
    `Nom : ${reservation.name}`,
    `Téléphone : ${customerPhone}`,
    `Courriel : ${reservation.email}`,
    `Service : ${departmentName}`,
    `Appareil ou service : ${reservation.serviceDetails}`,
    `Disponibilité souhaitée : ${dateAndTime}`,
    "Ce rendez-vous n'est pas encore confirmé.",
  ].join("\n");
  const customerEmailText = [
    `Bonjour ${reservation.name},`,
    "",
    "Nous avons bien reçu votre demande de rendez-vous chez Fix & Ride.",
    `Service : ${departmentName} - ${reservation.serviceDetails}`,
    `Disponibilité souhaitée : ${dateAndTime}`,
    "",
    "Votre rendez-vous n'est pas encore confirmé. Nous communiquerons avec vous pour le confirmer.",
  ].join("\n");
  const businessSms = `Fix & Ride: demande de ${reservation.name}, ${reservation.serviceDetails}, ${dateAndTime}. Rappelez ${customerPhone}.`;
  const customerSms = `Fix & Ride: nous avons reçu votre demande (${reservation.serviceDetails}, ${dateAndTime}). Ce rendez-vous n'est pas encore confirmé.`;

  const notifications = [
    ["business_email", () => sendEmail(
      resendApiKey,
      emailFrom,
      businessEmail,
      "Nouvelle demande de rendez-vous - Fix & Ride",
      businessEmailText,
    )],
    ["customer_email", () => sendEmail(
      resendApiKey,
      emailFrom,
      reservation.email,
      "Confirmation de réception - Fix & Ride",
      customerEmailText,
    )],
    ["business_sms", () => sendSms(
      twilioAccountSid,
      twilioAuthToken,
      twilioPhoneNumber,
      businessPhone,
      businessSms,
    )],
    ["customer_sms", () => sendSms(
      twilioAccountSid,
      twilioAuthToken,
      twilioPhoneNumber,
      customerPhone,
      customerSms,
    )],
  ] as const;

  const results = await Promise.allSettled(
    notifications.map(([, send]) => send()),
  );
  const notificationFailures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") {
      return [];
    }
    console.error(`${notifications[index][0]} failed:`, result.reason);
    return [notifications[index][0]];
  });

  return jsonResponse({ reservationId, notificationFailures });
});
