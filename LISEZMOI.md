# StatutPay — Next.js 14 + Supabase (PWA)

## Installation
Après `migration_v15.sql`, appliquez aussi les migrations `migration_v16.sql` à `migration_v27.sql` dans l’ordre numérique. Pour une base déjà à jour jusqu’à la v26, appliquez uniquement `migration_v27.sql`.

1. `npm install`
2. Copiez `.env.local.example` en `.env.local` et renseignez l’URL et la clé **anon** (Supabase > Project Settings > API).
3. Supabase > SQL Editor : collez `supabase/schema.sql` puis Run, **puis** `supabase/migration_v2.sql` puis Run (parrainage, favoris, classement, notifications, tableau de bord), **puis** `supabase/migration_v3.sql` puis Run (codes promo, boost, niveaux, avis, défis, rapports, profil), **puis** `supabase/migration_v4.sql` puis Run (campagnes programmées, parrainage 3 niveaux), **puis** `supabase/migration_v5.sql` puis Run (désactivation de l'ancienne vérification SMS), **puis** `supabase/migration_v6.sql` puis Run (médias pour les annonces), **puis** `supabase/migration_v7.sql` puis Run (réparation des colonnes de crédit manquantes), **puis** `supabase/migration_v8.sql` puis Run (réparation des colonnes de campagne manquantes), **puis** `supabase/migration_v9.sql` puis Run (administration), puis `supabase/migration_v11.sql` puis Run (réparation des colonnes du profil), `supabase/migration_v12.sql` puis Run (historique des transactions), `supabase/migration_v13.sql` puis Run (structure initiale des paiements), `supabase/migration_v14.sql` puis Run (portefeuille annonceur et AlphaPay), et enfin `supabase/migration_v15.sql` puis Run (activation automatique après paiement AlphaPay confirmé).
4. Supabase > Authentication > Providers > Email : laissez **« Confirm email » activé** (confirmation par e-mail obligatoire).
5. Supabase > Authentication > URL Configuration :
   - **Site URL** = l’adresse de votre site (ex : https://statutpay.vercel.app)
   - **Redirect URLs** : ajoutez l’adresse du site et `http://localhost:3000`
6. **E-mails en production** : le serveur d’e-mails par défaut de Supabase est limité (quelques e-mails par heure) et sert aux tests.
   Pour de vrai lancement, branchez votre propre SMTP (Resend, Brevo, SendGrid...) dans Authentication > SMTP Settings.
   Vous pouvez aussi personnaliser le texte du mail dans Authentication > Email Templates.
7. `npm run dev` puis ouvrez http://localhost:3000

## Admin
Inscrivez-vous dans l’app avec votre e-mail et le numéro +22896292039 (confirmez l’e-mail), puis dans le SQL Editor :
`update public.profiles set role='admin' where phone='+22896292039';`
Reconnectez-vous : l’onglet Admin apparaît.
Dans Admin > Utilisateurs, l’export CSV télécharge les contacts actuellement inscrits (nom et numéro WhatsApp), avec des colonnes compatibles avec l’import Google Contacts. Un nouveau téléchargement inclut automatiquement les nouvelles inscriptions; le fichier contient des données personnelles et doit être conservé avec précaution.

## Erreur pendant l’inscription
- Le message « Ce numéro WhatsApp est déjà utilisé » n’est affiché que si l’erreur Supabase indique explicitement une contrainte unique sur le téléphone. Une erreur générique d’enregistrement du profil ne signifie pas que le numéro est déjà pris.
- Si l’inscription échoue encore, consultez **Supabase > Logs > Auth** à l’heure de la tentative et vérifiez que les migrations nécessaires ont été appliquées.
- Si le journal mentionne `column "display_name" of relation "profiles" does not exist`, exécutez `supabase/migration_v11.sql` dans le SQL Editor Supabase, puis réessayez.

## Mise en ligne (Vercel)
1. Vérifiez localement `npm ci` puis `npm run build`. Le dépôt contient `package-lock.json`; ne publiez jamais `.env.local` (il est ignoré par Git).
2. Poussez les changements sur GitHub, puis importez le dépôt dans Vercel. Vercel doit détecter **Next.js** automatiquement; gardez la racine du projet et les paramètres de build par défaut (la commande de build est `npm run build`). `vercel.json` configure les rappels planifiés; aucune commande de démarrage personnalisée n’est nécessaire.
3. Dans **Project Settings > Environment Variables**, ajoutez les variables nécessaires dans les environnements Preview et/ou Production :
   - `NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_ANON_KEY` : valeurs Supabase du projet.
   - `SUPABASE_SERVICE_ROLE_KEY` : clé secrète Supabase, uniquement côté serveur.
   - `APP_BASE_URL` : URL HTTPS publique de l’environnement déployé, sans slash final.
   - `ALPHAPAY_API_BASE_URL`, `ALPHAPAY_API_KEY` et `ALPHAPAY_WEBHOOK_SECRET` : paramètres AlphaPay du même environnement. La clé doit avoir les scopes `PAYIN` et `PAYOUT` (ou `BOTH`).
   - Pour les notifications push, ajoutez aussi `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` et `CRON_SECRET`. La clé privée VAPID et `CRON_SECRET` restent secrets.
4. Pour tester les paiements, utilisez `ALPHAPAY_API_BASE_URL=https://sandbox-api.alphapay.me/api/v1` et une clé sandbox. Gardez `ALPHAPAY_PAYOUTS_ENABLED=false` : AlphaPay ne permet pas de tester les payouts en sandbox. Configurez le webhook sandbox vers `https://statutpay.vercel.app/webhooks/alphapay` avec les événements `transaction.success` et `transaction.failed`, puis placez son secret de signature dans `ALPHAPAY_WEBHOOK_SECRET`.
5. Dans Supabase > Authentication > URL Configuration, configurez l’URL du site et les URL de redirection Vercel (production et preview si nécessaire). Appliquez toutes les migrations, y compris `migration_v15.sql`, avant de tester les paiements AlphaPay.
6. Vérifiez le déploiement Preview et le parcours de paiement sandbox avant de déployer en production. Pour les paiements réels, configurez la clé et l’URL de production. Les payouts restent désactivés jusqu’à l’activation de la fonctionnalité sur votre compte AlphaPay et l’autorisation de l’IP sortante fixe de Vercel dans AlphaPay. Ne configurez `ALPHAPAY_PAYOUTS_ENABLED=true` qu’après ces vérifications.

Vercel fournit HTTPS; le service worker et l’installation PWA sont actifs sur les déploiements de production.

## Structure
- `src/app` : layout, page, styles
- `src/components` : App, AuthView, PublisherView, AdvertiserView, AdminView
- `src/lib` : client Supabase, types, traductions FR/EN
- `public` : manifest, service worker, icônes
- `supabase/schema.sql` : tables, sécurité (RLS), fonctions, stockage

## PWA et bouton « Installer l’app »
- Le bouton « Installer l’app » (en haut) et une bannière apparaissent automatiquement quand le navigateur permet l’installation (Android/Chrome, Edge, Chrome desktop).
- Sur iPhone (Safari), l’app affiche la marche à suivre : Partager > Sur l’écran d’accueil.
- Condition : version de production en HTTPS (`npm run build && npm start`, ou Vercel). En `npm run dev`, le service worker est volontairement désactivé.

## Onglet Annonces
Le flux « Annonces » liste les campagnes actives (filtres image/vidéo/texte, budget restant, bouton copier le texte, bouton « J’ai publié » qui mène à l’envoi de la preuve).

## Version 2 : nouveautés
- **Mot de passe oublié** : lien « Mot de passe oublié ? » sur la connexion. L’e-mail ramène sur le site, qui demande le nouveau mot de passe. Aucune config en plus (même Site URL / Redirect URLs que la confirmation).
- **Notifications push** : à l’activation d’une campagne par l’admin, tous les diffuseurs abonnés (du pays ciblé) reçoivent une notification.
  1. `npx web-push generate-vapid-keys`
  2. Dans `.env.local` (et dans Vercel) : `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `SUPABASE_SERVICE_ROLE_KEY`
  3. `SUPABASE_SERVICE_ROLE_KEY` est **secrète** (Supabase > Settings > API > service_role) : ne jamais la mettre dans le navigateur ni sur GitHub.
  4. Fonctionne en production HTTPS uniquement. Sur iPhone, l’app doit d’abord être installée sur l’écran d’accueil (iOS 16.4+).
  5. Les rappels de preuve requièrent aussi `supabase/migration_v26.sql` et le cron Vercel configuré dans `vercel.json`. Vérifiez que le forfait Vercel permet une exécution toutes les 5 minutes; sinon, utilisez un planificateur externe avec l’en-tête `Authorization: Bearer <CRON_SECRET>`.
- **Feed** : filtres Mon pays / Tous / Favoris et par format, cœur pour les favoris, ciblage par pays choisi par l’annonceur (un diffuseur ne peut soumettre que les annonces de son pays ou sans ciblage).
- **Contenu des annonces** : les diffuseurs peuvent télécharger les médias, copier le texte et la légende, télécharger le texte en `.txt` et partager via le menu natif ou WhatsApp.
- **Classement** : top 10 des diffuseurs du mois (numéros masqués) dans l’onglet Diffuseur.
- **Parrainage** : chaque compte a un lien `?ref=CODE`. Quand le filleul obtient sa première validation, le parrain reçoit 100 F (une seule fois par filleul). Montant modifiable dans `migration_v2.sql` (fonction `review_proof`) et `REF_BONUS` dans `src/lib/types.ts`. Ce bonus est payé par la plateforme.
- **Tableau de bord admin** : utilisateurs, revenus, vues, soldes, retraits, bonus, et deux graphiques sur 14 jours.

## Version 3 : nouveautés
- **Codes promo et crédit offert** : l'admin crée des codes (onglet Admin > Gestion > Codes promo). L'annonceur les saisit dans son onglet (un seul code par compte). Le crédit réduit le montant à payer ; s'il couvre tout, la campagne est activée automatiquement. Exemple de code de bienvenue : voir la fin de `migration_v3.sql`.
- **Campagnes boostées** : choisissez 24 h (500 F), 48 h (1 000 F) ou 7 jours (3 500 F) en tête du feed, avec l'étiquette « Sponsorisé ». Le compte à rebours démarre à l'activation.
- **Niveaux** : Bronze, Argent (5 validations, 80 % de réussite, +5 %), Or (20 validations, 90 %, +10 %). Le bonus est payé par la plateforme, en plus des 3 F par vue.
- **Avis** : après une preuve validée, le diffuseur note l'annonceur et l'annonceur note le diffuseur (1 à 5 étoiles + commentaire). La note de l'annonceur s'affiche dans le feed.
- **Défi du jour** : 3 preuves soumises le même jour ; +50 F versés automatiquement quand 3 preuves du jour sont validées.
- **Rapport de campagne** : vues livrées, diffuseurs, moyenne, preuves en attente/refusées et graphique 14 jours (bouton « Rapport »).
- **Aide** : bouton ? dans l'en-tête, avec FAQ (FR/EN, modifiable dans `src/lib/faq.ts`) et lien WhatsApp vers le support.
- **Profil** : bouton avatar dans l'en-tête, avec nom affiché (utilisé dans le classement), avatar, thème clair/sombre/auto et déconnexion.
- **Tableau de bord admin** : nouveaux indicateurs (crédits offerts, bonus niveaux et défis, campagnes boostées).

## Version 4 : nouveautés
- **Campagnes programmées** : dates de début et de fin facultatives. L'annonce n'est visible et soumettable que dans cette période. À l'échéance, la campagne est clôturée et le **budget non dépensé revient à l'annonceur en crédit** (utilisable sur ses prochaines campagnes, pas retirable). La clôture se déclenche à la connexion des utilisateurs (pas besoin de tâche planifiée).
- **Parrainage à 3 niveaux** : 100 F (amis invités), 30 F (amis de vos amis), 10 F (3e niveau), versés une seule fois à la première validation du filleul. **Ambassadeur** à 10 filleuls actifs : 150 F au niveau 1. Montants dans `review_proof` (migration_v4.sql) et `REF_LEVELS` dans `src/lib/types.ts`. Tous ces bonus sont payés par la plateforme.
- **Envoi des preuves hors connexion** : sans réseau, la capture est gardée sur le téléphone (IndexedDB) et envoyée automatiquement au retour de la connexion (bannière avec compteur et bouton « Envoyer maintenant »). L'app doit être ouverte pour que l'envoi parte.
- **Langues** : Français, English et **Português** complets. **Éwé** et **Mina** : les fichiers `src/lib/locales/ee.ts` et `gej.ts` sont prêts mais vides, car ces traductions doivent être faites par des locuteurs natifs. Donnez-leur `src/lib/locales/_template.json` (tous les textes en français) ; dès que 90 % sont traduits, la langue apparaît toute seule dans le sélecteur. Les textes manquants s'affichent en français.

## Version 5 : suppression de la vérification SMS
- L’envoi de codes par SMS et le réglage administrateur associé ont été retirés. Exécutez `supabase/migration_v5.sql` après la migration v4 pour que la base existante n’exige plus cette vérification pour envoyer des preuves ou demander un retrait.

## Version 6 : images et vidéos dans les annonces
- L’annonceur peut importer une image ou une vidéo, ou coller un lien HTTPS, avec une légende facultative. Les images sont limitées à 5 Mo et les vidéos à 20 Mo.
- Les fichiers sont stockés dans le bucket public `campaign-media` de Supabase Storage ; seuls les utilisateurs connectés peuvent importer ou supprimer leurs propres fichiers. Les médias d’annonce sont publics.
- Exécutez `supabase/migration_v6.sql` après la migration v5 avant de créer des annonces avec média.

## Version 7 : réparation du crédit
- Si la création d’une campagne affiche `column "credit" does not exist`, exécutez `supabase/migration_v7.sql` dans le SQL Editor de Supabase.

## Version 8 : réparation du schéma des campagnes
- Si la création d’une campagne affiche une colonne de `campaigns` manquante, exécutez `supabase/migration_v8.sql` dans le SQL Editor de Supabase. Cette migration est idempotente et ajoute les colonnes utilisées par la fonction de création actuelle.

## Version 9 : administration
- Exécutez `supabase/migration_v9.sql` dans le SQL Editor de Supabase pour ajouter la fonction d’activation des campagnes, les indicateurs du tableau de bord et l’historique des changements de statut.
- Le tableau admin inclut les indicateurs, les files d’activation/validation/retrait, la recherche d’utilisateurs et l’historique des changements de statut.

## Version 11 : réparation du profil
- Exécutez `supabase/migration_v11.sql` si l’inscription échoue avec une colonne `display_name` manquante. Elle ajoute aussi `avatar`, utilisé par l’édition du profil, sans toucher aux données existantes.

## Version 12 : historique des transactions
- Exécutez `supabase/migration_v12.sql` après les migrations v2, v3 et v4. Elle ajoute la fonction sécurisée `my_transactions`, limitée aux opérations de l’utilisateur connecté.
- Dans Profil > Gains et retraits, l’historique détaille les gains validés, bonus de niveau/parrainage/défi, crédits promo ajoutés/utilisés/remboursés, retraits et preuves en attente ou refusées.
- Le crédit promotionnel est affiché séparément du solde retirable.
- Cette migration n’ajoute pas de nouvelle table : elle reconstitue l’historique à partir des données existantes. Les opérations antérieures ne sont visibles que si leurs données sont encore présentes dans ces tables.

## Version 13 : structure initiale des paiements
- `migration_v13.sql` crée les tables et fonctions de paiement initiales. Appliquez ensuite `migration_v14.sql`, qui prépare le portefeuille et la valeur de fournisseur AlphaPay. Les noms `saspay_*` des objets SQL historiques sont conservés pour compatibilité; le prestataire actif dans l’application est AlphaPay.

## Version 14 : portefeuille annonceur et paiements automatiques
- Exécutez `supabase/migration_v14.sql` après la migration v13. Les annonceurs peuvent recharger leur portefeuille avec AlphaPay de 500 à 1 000 000 F. Le solde est crédité uniquement après vérification du paiement; les montants/devise atypiques apparaissent dans la file de vérification admin.
- Le crédit promo reste distinct et non retirable. Le portefeuille payant est utilisé pour une campagne seulement s’il couvre tout le montant restant après le crédit promo; sinon, l’annonceur paie le reste avec AlphaPay. Les fonds payants non dépensés d’une campagne sont rendus au portefeuille, tandis que les crédits promo non dépensés restent du crédit promo.
- Les retraits sont demandés automatiquement à AlphaPay après la demande de l’utilisateur, sans approbation admin préalable. Seuls les gains liés aux preuves validées (vues et bonus de niveau) sont retirables; les bonus de parrainage et du défi quotidien ne le sont pas. Un échec AlphaPay libère le solde réservé.
- Gardez `ALPHAPAY_PAYOUTS_ENABLED=false` et l’API en sandbox pour les paiements de test; les payouts ne sont pas disponibles en sandbox. Une demande de retrait reste réservée en attente tant que les payouts sont désactivés. En production, activez-les seulement après l’activation du service et l’autorisation de l’IP serveur dans AlphaPay.

## Version 15 : activation automatique des campagnes payées
- Exécutez `supabase/migration_v15.sql` après la migration v14.
- Dès qu’AlphaPay confirme un paiement réussi dans la devise attendue, la campagne passe automatiquement à l’état actif et apparaît dans le fil, sans approbation admin.
- Les frais du prestataire peuvent réduire le montant net reçu; ils ne bloquent plus l’activation. Une devise inattendue reste signalée pour vérification.

## Version 22 : preuves WhatsApp en deux temps
- Exécutez `supabase/migration_v22.sql` après la migration v21.
- Après avoir réellement publié le statut, le diffuseur confirme la publication dans l’application : cet instant définit H0. Il envoie une capture à partir de H+1, puis une seconde à partir de H+23, avant l’expiration du statut à H+24.
- L’admin examine les deux captures ensemble et saisit les vues. La rémunération (et les bonus associés) n’est accordée qu’après validation de la preuve H+23. Si une étape manque à son échéance, le dossier est refusé sans rémunération.
- Les preuves déjà déposées avant cette migration restent examinables selon l’ancien parcours. Les anciennes preuves encore en file hors ligne ne sont pas envoyées automatiquement : resoumettez-les avec le nouveau parcours ou supprimez-les explicitement depuis la bannière.

## Version 26 : rappels push des échéances de preuve
- Exécutez `supabase/migration_v26.sql` après les migrations précédentes. Elle relie les abonnements push au compte et planifie les rappels pour les preuves en cours.
- Si les notifications push sont activées, un rappel est envoyé environ 15 minutes avant la fin de chaque fenêtre : H+22 h 45 pour la capture H+1 et H+23 h 45 pour la capture H+23. Un rappel déjà rendu inutile par l’envoi de la capture est annulé.
- Le cron de `vercel.json` appelle `/api/proof-reminders` toutes les 5 minutes. Configurez `CRON_SECRET` dans les variables d’environnement Vercel; les clés VAPID et `SUPABASE_SERVICE_ROLE_KEY` doivent également être présentes. Le forfait Vercel doit autoriser cette fréquence ou un planificateur externe doit appeler la route avec le même secret.

## Version 27 : comptes agence
- Exécutez `supabase/migration_v27.sql` après la migration v26. Elle ajoute le rôle agence, les fiches annonceurs et les invitations à accepter.
- Une agence peut créer une campagne pour un annonceur géré ou ayant accepté son invitation. La campagne est créée sous le compte agence, payée séparément avec AlphaPay et ses budgets/dépenses sont ventilés par annonceur.

## Capture des preuves depuis l’application
- Pour chaque preuve H+1/H+23, le diffuseur peut prendre une photo avec la caméra, choisir une image déjà enregistrée ou capturer un écran/fenêtre si le navigateur le permet.
- La capture d’écran exige une sélection et une autorisation du navigateur. Sur téléphone, la capture d’une autre application peut être indisponible; utilisez alors la caméra ou une capture enregistrée. L’envoi reste limité aux images de 5 Mo maximum.

