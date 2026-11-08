# Fix & Ride

## Reservation notifications

Reservation requests are stored in Supabase and handled by the `request-reservation` Edge Function. It sends an email through Resend and an SMS through Twilio to both the shop and the customer. Customer messages confirm receipt only; they do not confirm the appointment.

### Configure the project

1. Create a Supabase project and install the [Supabase CLI](https://supabase.com/docs/guides/cli).
2. Link this repository to the project and apply the database migration:

   ```sh
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```

3. Configure the Edge Function secrets. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are available in the function environment for Supabase-hosted projects; set them explicitly if they are not present in your environment. Use the service-role key only as a function secret—never in the browser.

   ```sh
   supabase secrets set \
     RESEND_API_KEY=YOUR_RESEND_API_KEY \
     EMAIL_FROM="Fix & Ride <notifications@your-verified-domain.ca>" \
     BUSINESS_EMAIL=YOUR_SHOP_EMAIL \
     BUSINESS_PHONE=+15146088177 \
     TWILIO_ACCOUNT_SID=YOUR_TWILIO_ACCOUNT_SID \
     TWILIO_AUTH_TOKEN=YOUR_TWILIO_AUTH_TOKEN \
     TWILIO_PHONE_NUMBER=+1YOUR_TWILIO_NUMBER
   ```

   Verify your sending domain with Resend and configure a Twilio number that can send SMS to your customers' countries.

4. Deploy the function:

   ```sh
   supabase functions deploy request-reservation
   ```

5. In `index.html`, replace `YOUR_PROJECT_REF` in `SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` with the project URL and public anon key from **Project Settings → API**. The anon key is intended for browser use; do not put the service-role key there.

The function validates each request, inserts it into `public.reservations`, then attempts all four notifications. If a notification provider fails after the reservation has been saved, the form confirms that the request was recorded and warns that some notifications could not be sent. Review Edge Function logs for delivery errors.