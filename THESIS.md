# Praca inżynierska — Kontekst i dokumentacja

## Temat

**Projekt i dokumentacja infrastruktury systemu e-commerce w chmurze publicznej**

## Cel pracy

Opracowanie projektu środowiska wykonawczego systemu e-commerce w chmurze Amazon Web Services (AWS), spełniającego wymagania wysokiej dostępności, skalowalności, niezawodności oraz bezpieczeństwa.

## Zakres pracy (oficjalny opis dla uczelni)

Praca obejmuje zaprojektowanie infrastruktury systemu z wykorzystaniem narzędzi Infrastructure as Code (IaC) w chmurze publicznej AWS dla przykładowej, uproszczonej aplikacji e-commerce oraz opracowanie zautomatyzowanego procesu wdrażania. Projekt będzie oparty na architekturze mikroserwisowej, co zapewni elastyczność, łatwość zarządzania oraz możliwość skalowania i dalszego rozwoju aplikacji.

W ramach pracy zostaną uwzględnione następujące elementy:

- **Application Gateway** jako centralny punkt wejścia do systemu oraz komponent odpowiedzialny za autoryzację użytkowników
- **Application Load Balancer** zapewniający równoważenie obciążenia
- **Serwisy aplikacyjne** wdrożone z wykorzystaniem Elastic Container Service (Docker) oraz AWS Lambda
- **Bazy danych** dostosowane do potrzeb poszczególnych komponentów systemu – relacyjne (Amazon RDS) oraz dokumentowe (Amazon DynamoDB)
- **Systemy asynchronicznej wymiany danych** oparte na usługach Amazon SQS oraz Amazon SNS
- **Środowisko sieciowe** systemu, w tym integracja z Virtual Private Network (VPN)
- **Monitoring i logowanie** z wykorzystaniem Amazon CloudWatch oraz AWS X-Ray
- **Zasady bezpieczeństwa**, obejmujące konfigurację Identity and Access Management (IAM), Virtual Private Cloud (VPC), Security Groups oraz AWS Web Application Firewall (WAF)
- **Zautomatyzowany proces wdrażania**, wykorzystujący AWS CodePipeline i AWS CodeDeploy

Przygotowany projekt będzie stanowił kompletną dokumentację infrastruktury systemu e-commerce w chmurze AWS, z naciskiem na najlepsze praktyki w zakresie niezawodności, bezpieczeństwa i skalowalności.

---

## Struktura pracy

Praca składa się z trzech części:

### Część 1 — Teoretyczna / historyczna
Przegląd literatury i kontekst technologiczny. Tematy do omówienia:
- Architektura klient-serwer — historia i ewolucja
- Systemy rozproszone — pojęcia, wyzwania, wzorce
- Chmura publiczna — modele (IaaS, PaaS, SaaS), główni dostawcy, AWS
- Mikroserwisy vs. monolit — motywacja, trade-offy
- Infrastructure as Code (IaC) — narzędzia, podejścia, AWS CDK
- Bezpieczeństwo w chmurze — IAM, VPC, WAF, dobre praktyki
- Skalowalność i wysokia dostępność — wzorce, auto-scaling, multi-AZ

### Część 2 — Praktyczna (opis kodu i infrastruktury)
Dokumentacja techniczna zaprojektowanego systemu:
- Opis architektury systemu
- Omówienie poszczególnych komponentów AWS
- Wzorzec sagi (distributed transactions) i jego implementacja
- Decyzje projektowe i ich uzasadnienie
- Proces wdrażania (CI/CD)

### Część 3 — Repozytorium kodu
Kod źródłowy w repozytorium GitHub (`kubasulek2/marketplace`):
- Infrastruktura jako kod (AWS CDK, TypeScript)
- Kod aplikacyjny mikroserwisów (Node.js, Lambda, Express)
- Pipeline CI/CD (GitHub Actions)

---

## Język

Praca pisana w języku **polskim**.

---

## Notatki robocze

<!-- Tutaj będziemy dodawać notatki, decyzje i postępy w pisaniu pracy -->
