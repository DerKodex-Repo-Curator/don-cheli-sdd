//! Service catalog — knowledge base of common SaaS / API services
//! that Don Cheli-generated apps typically integrate with.
//!
//! For each service we know:
//!  - which npm/python packages indicate its use
//!  - which env vars it needs
//!  - how to get the keys (URL to dashboard + step-by-step instructions)
//!  - which env vars are server-side (secret) vs client-side (public)

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct ServiceSpec {
    pub id: String,
    pub name: String,
    pub category: String,         // "Maps" | "Auth" | "Database" | "Payments" | "AI" | "Email" | "Analytics" | "Storage"
    pub description: String,
    pub dashboard_url: String,
    pub docs_url: String,
    pub free_tier: String,        // human-readable
    pub instructions: Vec<String>,
    pub env_keys: Vec<ServiceKey>,
    /// npm package names (any match triggers detection)
    pub npm_packages: Vec<String>,
    /// env var names (any match triggers detection)
    pub env_var_patterns: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ServiceKey {
    pub name: String,
    pub label: String,
    pub kind: String,             // "public" | "secret"
    pub example_prefix: Option<String>,
    pub description: String,
}

pub fn catalog() -> Vec<ServiceSpec> {
    vec![
        // ─── Maps ───
        ServiceSpec {
            id: "mapbox".to_string(),
            name: "Mapbox".to_string(),
            category: "Maps".to_string(),
            description: "Mapas interactivos vectoriales con estilos personalizados.".to_string(),
            dashboard_url: "https://account.mapbox.com/access-tokens/".to_string(),
            docs_url: "https://docs.mapbox.com/help/getting-started/access-tokens/".to_string(),
            free_tier: "50,000 cargas de mapa al mes gratis".to_string(),
            instructions: vec![
                "1. Crea una cuenta gratis en mapbox.com (no requiere tarjeta).".to_string(),
                "2. Ve al dashboard de Access Tokens (link de abajo).".to_string(),
                "3. Usa el \"Default public token\" o crea uno nuevo con scope public.".to_string(),
                "4. Pega el token que empieza con `pk.eyJ1Ij...` en el campo.".to_string(),
            ],
            env_keys: vec![
                ServiceKey {
                    name: "NEXT_PUBLIC_MAPBOX_TOKEN".to_string(),
                    label: "Access Token público".to_string(),
                    kind: "public".to_string(),
                    example_prefix: Some("pk.eyJ1Ij...".to_string()),
                    description: "Token público. Se expone en el browser, no es secreto.".to_string(),
                },
            ],
            npm_packages: vec![
                "mapbox-gl".to_string(),
                "react-map-gl".to_string(),
                "@mapbox/mapbox-gl-geocoder".to_string(),
            ],
            env_var_patterns: vec!["MAPBOX".to_string()],
        },

        ServiceSpec {
            id: "google-maps".to_string(),
            name: "Google Maps".to_string(),
            category: "Maps".to_string(),
            description: "Mapas, geocoding, places y direcciones de Google.".to_string(),
            dashboard_url: "https://console.cloud.google.com/google/maps-apis/credentials".to_string(),
            docs_url: "https://developers.google.com/maps/documentation/javascript/get-api-key".to_string(),
            free_tier: "$200 de crédito al mes (≈ 28.000 cargas)".to_string(),
            instructions: vec![
                "1. Entra a Google Cloud Console (link de abajo).".to_string(),
                "2. Crea un proyecto nuevo o usa uno existente.".to_string(),
                "3. Habilita las APIs que tu app necesita: Maps JavaScript, Places, Geocoding.".to_string(),
                "4. En Credenciales → crea una API Key.".to_string(),
                "5. (Recomendado) Restringe la key a tu dominio en \"HTTP referrers\".".to_string(),
            ],
            env_keys: vec![
                ServiceKey {
                    name: "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY".to_string(),
                    label: "API Key".to_string(),
                    kind: "public".to_string(),
                    example_prefix: Some("AIza...".to_string()),
                    description: "Restringe la key por dominio en producción.".to_string(),
                },
            ],
            npm_packages: vec![
                "@react-google-maps/api".to_string(),
                "@googlemaps/js-api-loader".to_string(),
                "google-map-react".to_string(),
            ],
            env_var_patterns: vec!["GOOGLE_MAPS".to_string(), "GOOGLE_API_KEY".to_string()],
        },

        // ─── Database / BaaS ───
        ServiceSpec {
            id: "supabase".to_string(),
            name: "Supabase".to_string(),
            category: "Database".to_string(),
            description: "Postgres en la nube + Auth + Storage + Realtime. Open source.".to_string(),
            dashboard_url: "https://supabase.com/dashboard/projects".to_string(),
            docs_url: "https://supabase.com/docs/guides/getting-started".to_string(),
            free_tier: "2 proyectos gratis · 500 MB DB · 1 GB storage".to_string(),
            instructions: vec![
                "1. Crea cuenta en supabase.com (con GitHub o email).".to_string(),
                "2. Click \"New project\" — elige nombre, password (guárdalo) y región.".to_string(),
                "3. Espera ~2 min mientras se aprovisiona la DB.".to_string(),
                "4. Ve a Settings → API. Copia \"Project URL\" y \"anon public\".".to_string(),
                "5. Pega Project URL en NEXT_PUBLIC_SUPABASE_URL.".to_string(),
                "6. Pega anon public en NEXT_PUBLIC_SUPABASE_ANON_KEY.".to_string(),
                "7. (Opcional, sólo si tu app lo necesita) En la misma pantalla copia \"service_role\" para SUPABASE_SERVICE_ROLE_KEY — es secreta, no expongas en el browser.".to_string(),
            ],
            env_keys: vec![
                ServiceKey {
                    name: "NEXT_PUBLIC_SUPABASE_URL".to_string(),
                    label: "Project URL".to_string(),
                    kind: "public".to_string(),
                    example_prefix: Some("https://xxxxx.supabase.co".to_string()),
                    description: "URL pública de tu proyecto.".to_string(),
                },
                ServiceKey {
                    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY".to_string(),
                    label: "Anon public key".to_string(),
                    kind: "public".to_string(),
                    example_prefix: Some("eyJhbGciOiJIUzI1NiIs...".to_string()),
                    description: "Key pública. Se expone al browser. La seguridad real la da Row Level Security.".to_string(),
                },
            ],
            npm_packages: vec![
                "@supabase/supabase-js".to_string(),
                "@supabase/ssr".to_string(),
                "@supabase/auth-helpers-nextjs".to_string(),
            ],
            env_var_patterns: vec!["SUPABASE".to_string()],
        },

        ServiceSpec {
            id: "firebase".to_string(),
            name: "Firebase".to_string(),
            category: "Database".to_string(),
            description: "BaaS de Google: Firestore + Auth + Storage + Hosting.".to_string(),
            dashboard_url: "https://console.firebase.google.com/".to_string(),
            docs_url: "https://firebase.google.com/docs/web/setup".to_string(),
            free_tier: "Spark plan gratis: 1GB DB, 10GB storage, 50K reads/día".to_string(),
            instructions: vec![
                "1. Ve a la Firebase Console y crea un proyecto.".to_string(),
                "2. Añade una app Web (icono </>) y registra el nombre.".to_string(),
                "3. Firebase te muestra un objeto `firebaseConfig` con todas las keys.".to_string(),
                "4. Copia cada valor del config a las variables de abajo.".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "NEXT_PUBLIC_FIREBASE_API_KEY".to_string(), label: "API Key".to_string(), kind: "public".to_string(), example_prefix: Some("AIza...".to_string()), description: "".to_string() },
                ServiceKey { name: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN".to_string(), label: "Auth Domain".to_string(), kind: "public".to_string(), example_prefix: Some("xxx.firebaseapp.com".to_string()), description: "".to_string() },
                ServiceKey { name: "NEXT_PUBLIC_FIREBASE_PROJECT_ID".to_string(), label: "Project ID".to_string(), kind: "public".to_string(), example_prefix: None, description: "".to_string() },
                ServiceKey { name: "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET".to_string(), label: "Storage Bucket".to_string(), kind: "public".to_string(), example_prefix: Some("xxx.appspot.com".to_string()), description: "".to_string() },
                ServiceKey { name: "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID".to_string(), label: "Messaging Sender ID".to_string(), kind: "public".to_string(), example_prefix: None, description: "".to_string() },
                ServiceKey { name: "NEXT_PUBLIC_FIREBASE_APP_ID".to_string(), label: "App ID".to_string(), kind: "public".to_string(), example_prefix: Some("1:...".to_string()), description: "".to_string() },
            ],
            npm_packages: vec!["firebase".to_string(), "firebase-admin".to_string()],
            env_var_patterns: vec!["FIREBASE".to_string()],
        },

        // ─── Auth ───
        ServiceSpec {
            id: "clerk".to_string(),
            name: "Clerk".to_string(),
            category: "Auth".to_string(),
            description: "Auth completo: login, signup, MFA, organizations, UI prefabricado.".to_string(),
            dashboard_url: "https://dashboard.clerk.com/".to_string(),
            docs_url: "https://clerk.com/docs/quickstarts/nextjs".to_string(),
            free_tier: "10,000 MAU gratis".to_string(),
            instructions: vec![
                "1. Crea cuenta en clerk.com.".to_string(),
                "2. Click \"Add application\", elige proveedores (Google, GitHub, email…) y crea.".to_string(),
                "3. En API Keys verás \"Publishable key\" y \"Secret key\". Cópialas.".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY".to_string(), label: "Publishable key".to_string(), kind: "public".to_string(), example_prefix: Some("pk_test_...".to_string()), description: "Se expone al browser.".to_string() },
                ServiceKey { name: "CLERK_SECRET_KEY".to_string(), label: "Secret key".to_string(), kind: "secret".to_string(), example_prefix: Some("sk_test_...".to_string()), description: "NUNCA expongas esta key al browser.".to_string() },
            ],
            npm_packages: vec!["@clerk/nextjs".to_string(), "@clerk/clerk-react".to_string(), "@clerk/clerk-sdk-node".to_string()],
            env_var_patterns: vec!["CLERK".to_string()],
        },

        ServiceSpec {
            id: "auth0".to_string(),
            name: "Auth0".to_string(),
            category: "Auth".to_string(),
            description: "Auth as a service de Okta. Enterprise-grade.".to_string(),
            dashboard_url: "https://manage.auth0.com/dashboard/".to_string(),
            docs_url: "https://auth0.com/docs/quickstart/webapp/nextjs".to_string(),
            free_tier: "7,500 MAU gratis".to_string(),
            instructions: vec![
                "1. Crea cuenta en auth0.com.".to_string(),
                "2. Crea una nueva aplicación tipo \"Regular Web Application\".".to_string(),
                "3. En Settings encuentras Domain, Client ID y Client Secret. Cópialos.".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "AUTH0_DOMAIN".to_string(), label: "Domain".to_string(), kind: "public".to_string(), example_prefix: Some("xxx.auth0.com".to_string()), description: "".to_string() },
                ServiceKey { name: "AUTH0_CLIENT_ID".to_string(), label: "Client ID".to_string(), kind: "public".to_string(), example_prefix: None, description: "".to_string() },
                ServiceKey { name: "AUTH0_CLIENT_SECRET".to_string(), label: "Client Secret".to_string(), kind: "secret".to_string(), example_prefix: None, description: "".to_string() },
            ],
            npm_packages: vec!["@auth0/nextjs-auth0".to_string(), "@auth0/auth0-react".to_string(), "auth0".to_string()],
            env_var_patterns: vec!["AUTH0".to_string()],
        },

        ServiceSpec {
            id: "nextauth".to_string(),
            name: "NextAuth.js".to_string(),
            category: "Auth".to_string(),
            description: "Auth para Next.js. Self-hosted, soporta 50+ providers.".to_string(),
            dashboard_url: "https://next-auth.js.org/".to_string(),
            docs_url: "https://next-auth.js.org/configuration/options".to_string(),
            free_tier: "Open source · gratis".to_string(),
            instructions: vec![
                "1. Genera un secret aleatorio: `openssl rand -base64 32`.".to_string(),
                "2. Pega el resultado en NEXTAUTH_SECRET.".to_string(),
                "3. NEXTAUTH_URL debe ser la URL de tu app (http://localhost:3000 en dev).".to_string(),
                "4. Si usas providers OAuth, también necesitarás sus client IDs (Google, GitHub, etc.).".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "NEXTAUTH_SECRET".to_string(), label: "Secret".to_string(), kind: "secret".to_string(), example_prefix: None, description: "Genera con: openssl rand -base64 32".to_string() },
                ServiceKey { name: "NEXTAUTH_URL".to_string(), label: "URL".to_string(), kind: "public".to_string(), example_prefix: Some("http://localhost:3000".to_string()), description: "URL pública de tu app".to_string() },
            ],
            npm_packages: vec!["next-auth".to_string()],
            env_var_patterns: vec!["NEXTAUTH".to_string()],
        },

        // ─── Payments ───
        ServiceSpec {
            id: "stripe".to_string(),
            name: "Stripe".to_string(),
            category: "Payments".to_string(),
            description: "Pagos, suscripciones, marketplaces.".to_string(),
            dashboard_url: "https://dashboard.stripe.com/test/apikeys".to_string(),
            docs_url: "https://stripe.com/docs/keys".to_string(),
            free_tier: "Sin fee fijo · 2.9% + $0.30 por transacción".to_string(),
            instructions: vec![
                "1. Crea cuenta en stripe.com (puedes usar modo test sin verificar empresa).".to_string(),
                "2. Asegúrate de estar en modo \"Test\" (toggle arriba a la derecha).".to_string(),
                "3. Ve a Developers → API keys.".to_string(),
                "4. Copia \"Publishable key\" (pk_test_...) y \"Secret key\" (sk_test_...).".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY".to_string(), label: "Publishable key".to_string(), kind: "public".to_string(), example_prefix: Some("pk_test_...".to_string()), description: "Se expone al browser.".to_string() },
                ServiceKey { name: "STRIPE_SECRET_KEY".to_string(), label: "Secret key".to_string(), kind: "secret".to_string(), example_prefix: Some("sk_test_...".to_string()), description: "Server-side only.".to_string() },
                ServiceKey { name: "STRIPE_WEBHOOK_SECRET".to_string(), label: "Webhook signing secret".to_string(), kind: "secret".to_string(), example_prefix: Some("whsec_...".to_string()), description: "(Opcional) Verifica webhooks de Stripe.".to_string() },
            ],
            npm_packages: vec!["stripe".to_string(), "@stripe/stripe-js".to_string(), "@stripe/react-stripe-js".to_string()],
            env_var_patterns: vec!["STRIPE".to_string()],
        },

        // ─── AI ───
        ServiceSpec {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            category: "AI".to_string(),
            description: "GPT-4, GPT-5, embeddings, Whisper, DALL-E.".to_string(),
            dashboard_url: "https://platform.openai.com/api-keys".to_string(),
            docs_url: "https://platform.openai.com/docs/quickstart".to_string(),
            free_tier: "Sin tier gratis · pay-per-use con créditos iniciales".to_string(),
            instructions: vec![
                "1. Crea cuenta en platform.openai.com (requiere agregar tarjeta).".to_string(),
                "2. Click \"+ Create new secret key\".".to_string(),
                "3. Asigna un nombre y guarda — solo la verás una vez.".to_string(),
                "4. Pega el sk-proj-... en el campo.".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "OPENAI_API_KEY".to_string(), label: "API Key".to_string(), kind: "secret".to_string(), example_prefix: Some("sk-proj-...".to_string()), description: "Server-side only.".to_string() },
            ],
            npm_packages: vec!["openai".to_string()],
            env_var_patterns: vec!["OPENAI".to_string()],
        },

        ServiceSpec {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            category: "AI".to_string(),
            description: "Claude (Sonnet, Opus, Haiku) vía API.".to_string(),
            dashboard_url: "https://console.anthropic.com/settings/keys".to_string(),
            docs_url: "https://docs.anthropic.com/claude/reference/getting-started-with-the-api".to_string(),
            free_tier: "$5 de crédito gratis al verificar email".to_string(),
            instructions: vec![
                "1. Crea cuenta en console.anthropic.com.".to_string(),
                "2. En API Keys click \"Create Key\".".to_string(),
                "3. Pega la key (sk-ant-api03-...).".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "ANTHROPIC_API_KEY".to_string(), label: "API Key".to_string(), kind: "secret".to_string(), example_prefix: Some("sk-ant-api03-...".to_string()), description: "Server-side only.".to_string() },
            ],
            npm_packages: vec!["@anthropic-ai/sdk".to_string()],
            env_var_patterns: vec!["ANTHROPIC".to_string()],
        },

        // ─── Email ───
        ServiceSpec {
            id: "resend".to_string(),
            name: "Resend".to_string(),
            category: "Email".to_string(),
            description: "Transactional email API. Diseñado para developers.".to_string(),
            dashboard_url: "https://resend.com/api-keys".to_string(),
            docs_url: "https://resend.com/docs/introduction".to_string(),
            free_tier: "3,000 emails/mes gratis · 100 emails/día".to_string(),
            instructions: vec![
                "1. Crea cuenta en resend.com.".to_string(),
                "2. (Opcional) Verifica tu dominio si quieres enviar desde tu email custom.".to_string(),
                "3. En API Keys → Create API Key. Cópiala.".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "RESEND_API_KEY".to_string(), label: "API Key".to_string(), kind: "secret".to_string(), example_prefix: Some("re_...".to_string()), description: "Server-side only.".to_string() },
            ],
            npm_packages: vec!["resend".to_string()],
            env_var_patterns: vec!["RESEND".to_string()],
        },

        ServiceSpec {
            id: "sendgrid".to_string(),
            name: "SendGrid".to_string(),
            category: "Email".to_string(),
            description: "Email transaccional de Twilio.".to_string(),
            dashboard_url: "https://app.sendgrid.com/settings/api_keys".to_string(),
            docs_url: "https://docs.sendgrid.com/for-developers/sending-email/api-getting-started".to_string(),
            free_tier: "100 emails/día gratis para siempre".to_string(),
            instructions: vec![
                "1. Crea cuenta en sendgrid.com.".to_string(),
                "2. Settings → API Keys → Create API Key.".to_string(),
                "3. Elige \"Full Access\" o restringe a Mail Send.".to_string(),
                "4. Copia la key (solo aparece una vez).".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "SENDGRID_API_KEY".to_string(), label: "API Key".to_string(), kind: "secret".to_string(), example_prefix: Some("SG....".to_string()), description: "".to_string() },
            ],
            npm_packages: vec!["@sendgrid/mail".to_string()],
            env_var_patterns: vec!["SENDGRID".to_string()],
        },

        // ─── Analytics ───
        ServiceSpec {
            id: "posthog".to_string(),
            name: "PostHog".to_string(),
            category: "Analytics".to_string(),
            description: "Product analytics + session recording + feature flags.".to_string(),
            dashboard_url: "https://us.posthog.com/project/settings".to_string(),
            docs_url: "https://posthog.com/docs/integrate".to_string(),
            free_tier: "1M eventos/mes gratis".to_string(),
            instructions: vec![
                "1. Crea cuenta en posthog.com.".to_string(),
                "2. En Project Settings copia el \"Project API Key\".".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "NEXT_PUBLIC_POSTHOG_KEY".to_string(), label: "Project API Key".to_string(), kind: "public".to_string(), example_prefix: Some("phc_...".to_string()), description: "Token público.".to_string() },
                ServiceKey { name: "NEXT_PUBLIC_POSTHOG_HOST".to_string(), label: "Host".to_string(), kind: "public".to_string(), example_prefix: Some("https://us.i.posthog.com".to_string()), description: "Usa us.i.posthog.com o eu.i.posthog.com.".to_string() },
            ],
            npm_packages: vec!["posthog-js".to_string(), "posthog-node".to_string()],
            env_var_patterns: vec!["POSTHOG".to_string()],
        },

        ServiceSpec {
            id: "sentry".to_string(),
            name: "Sentry".to_string(),
            category: "Analytics".to_string(),
            description: "Error tracking y performance monitoring.".to_string(),
            dashboard_url: "https://sentry.io/settings/".to_string(),
            docs_url: "https://docs.sentry.io/platforms/javascript/guides/nextjs/".to_string(),
            free_tier: "5K errors/mes gratis".to_string(),
            instructions: vec![
                "1. Crea cuenta en sentry.io.".to_string(),
                "2. Create new project → Next.js (o tu framework).".to_string(),
                "3. Copia el DSN que te muestra.".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "NEXT_PUBLIC_SENTRY_DSN".to_string(), label: "DSN".to_string(), kind: "public".to_string(), example_prefix: Some("https://xxx@sentry.io/xxx".to_string()), description: "".to_string() },
            ],
            npm_packages: vec!["@sentry/nextjs".to_string(), "@sentry/react".to_string(), "@sentry/node".to_string()],
            env_var_patterns: vec!["SENTRY".to_string()],
        },

        // ─── AI ───
        ServiceSpec {
            id: "gemini".to_string(),
            name: "Google Gemini".to_string(),
            category: "AI".to_string(),
            description: "LLM de Google (Pro / Flash). Útil para chat, summarization, generación.".to_string(),
            dashboard_url: "https://aistudio.google.com/apikey".to_string(),
            docs_url: "https://ai.google.dev/gemini-api/docs".to_string(),
            free_tier: "60 req/min en Flash. Cuotas generosas en tier free.".to_string(),
            instructions: vec![
                "1. Andá a aistudio.google.com → Get API Key.".to_string(),
                "2. Create API Key.".to_string(),
                "3. Copiá la key (empieza con AIzaSy...).".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "GEMINI_API_KEY".to_string(), label: "API Key".to_string(), kind: "secret".to_string(), example_prefix: Some("AIzaSy...".to_string()), description: "Server-side only.".to_string() },
                ServiceKey { name: "GEMINI_MODEL".to_string(), label: "Default model".to_string(), kind: "public".to_string(), example_prefix: Some("gemini-2.5-flash".to_string()), description: "Modelo por defecto (opcional).".to_string() },
            ],
            npm_packages: vec!["@google/generative-ai".to_string(), "@google/genai".to_string()],
            env_var_patterns: vec!["GEMINI".to_string()],
        },

        // ─── Monetización ───
        ServiceSpec {
            id: "adsense".to_string(),
            name: "Google AdSense".to_string(),
            category: "Monetización".to_string(),
            description: "Publicidad. Banner / in-feed / multiplex en sitios y apps.".to_string(),
            dashboard_url: "https://www.google.com/adsense".to_string(),
            docs_url: "https://support.google.com/adsense/answer/9274516".to_string(),
            free_tier: "Sin costo — cobra al usuario final.".to_string(),
            instructions: vec![
                "1. Crea cuenta en adsense.google.com y verifica el sitio.".to_string(),
                "2. Anuncios → Por unidad de anuncio → Crear (Banner, In-feed, Multiplex).".to_string(),
                "3. Copia el data-ad-client y data-ad-slot de cada unidad.".to_string(),
            ],
            env_keys: vec![
                ServiceKey { name: "NEXT_PUBLIC_ADSENSE_CLIENT".to_string(), label: "AdSense Publisher ID".to_string(), kind: "public".to_string(), example_prefix: Some("ca-pub-...".to_string()), description: "Tu ID de cliente.".to_string() },
                ServiceKey { name: "NEXT_PUBLIC_ADSENSE_SLOT_BANNER".to_string(), label: "Banner slot ID".to_string(), kind: "public".to_string(), example_prefix: None, description: "Slot ID del anuncio tipo banner.".to_string() },
                ServiceKey { name: "NEXT_PUBLIC_ADSENSE_SLOT_INFEED".to_string(), label: "In-feed slot ID".to_string(), kind: "public".to_string(), example_prefix: None, description: "Slot ID del anuncio in-feed.".to_string() },
            ],
            npm_packages: vec![],
            env_var_patterns: vec!["ADSENSE".to_string()],
        },
    ]
}

/// Detect which services are used by a project based on npm deps and env vars.
pub fn detect_services(
    deps: &std::collections::HashMap<String, String>,
    env_var_names: &[String],
) -> Vec<ServiceSpec> {
    let services = catalog();
    let mut out = Vec::new();

    for svc in services {
        let matches_npm = svc.npm_packages.iter().any(|p| deps.contains_key(p));
        let matches_env = svc.env_var_patterns.iter().any(|pat|
            env_var_names.iter().any(|n| n.contains(pat))
        );
        if matches_npm || matches_env {
            out.push(svc);
        }
    }

    out
}

/// Keywords / aliases / friendly mentions per service. Used to detect
/// services from free-form text (a task description, a blueprint.md, etc.).
fn keywords_for(service_id: &str) -> &'static [&'static str] {
    match service_id {
        "mapbox" => &["mapbox", "mapbox-gl", "mapbox gl"],
        "google-maps" => &["google maps", "google-maps", "googlemaps", "maps api de google", "places api"],
        "supabase" => &["supabase", "supabase-js", "supabase auth", "supabase realtime"],
        "firebase" => &["firebase", "firestore", "firebase auth"],
        "clerk" => &["clerk", "clerk.com", "clerk auth"],
        "auth0" => &["auth0", "auth zero"],
        "nextauth" => &["nextauth", "next-auth", "next auth"],
        "stripe" => &["stripe", "stripe payments", "stripe webhooks", "stripe subscription"],
        "openai" => &["openai", "open ai", "gpt-4", "gpt-5", "gpt 4", "gpt 5", "chatgpt api"],
        "anthropic" => &["anthropic", "claude api", "claude sonnet", "claude opus"],
        "resend" => &["resend", "resend.com"],
        "sendgrid" => &["sendgrid", "send grid"],
        "posthog" => &["posthog", "post hog", "product analytics"],
        "sentry" => &["sentry", "sentry.io", "error tracking"],
        _ => &[],
    }
}

/// Detect services from free-form text (case-insensitive).
/// Used for: task descriptions in NuevoTrabajo, blueprint.md, spec.md, etc.
pub fn detect_in_text(text: &str) -> Vec<ServiceSpec> {
    let lower = text.to_lowercase();
    let services = catalog();
    let mut out = Vec::new();
    for svc in services {
        let mut hit = false;
        // Try the service display name first
        if lower.contains(&svc.name.to_lowercase()) { hit = true; }
        // Then npm packages
        if !hit && svc.npm_packages.iter().any(|p| lower.contains(&p.to_lowercase())) { hit = true; }
        // Then known keywords / aliases
        if !hit && keywords_for(&svc.id).iter().any(|k| lower.contains(k)) { hit = true; }
        // Then env var patterns (e.g. user pasting "STRIPE_SECRET_KEY")
        if !hit && svc.env_var_patterns.iter().any(|pat| lower.contains(&pat.to_lowercase())) { hit = true; }

        if hit { out.push(svc); }
    }
    out
}
