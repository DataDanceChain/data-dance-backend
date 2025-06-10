const bcrypt = require('bcryptjs');
const prisma = require('../src/utils/prisma');
const { generateReferralCode } = require('../src/utils/referralUtils');

// 活动类型枚举
const ActivityType = {
  MEMBERSHIP: 'MEMBERSHIP',
  REDEMPTION: 'REDEMPTION'
};

// 活动数据 - 完整列表，无省略
const activities = [
  {
    id: 'yacht-club-membership',
    title: "Elite Yacht Club Membership NFT Limited Sale",
    coverImage: "/assets/nfts/yacht-club.png",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-02-19",
        end: "2026-03-19"
      }
    },
    organizer: {
      name: "Yacht Club",
      avatar: "/assets/logos/yacht-club.png"
    },
    status: {
      remaining: 100,
      total: 100,
      note: "Limited edition, while supplies last"
    },
    description: "Elite Yacht Club membership benefits available for priority purchase, limited to 100 units. Benefits include 60 hours of private yacht usage, free participation in elite gatherings, VIP member area consumption, and cigar room usage without minimum consumption.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "60 hours of private yacht usage",
        "Free participation in elite gatherings",
        "Exclusive access to 2F VIP member area",
        "Cigar room usage without minimum consumption"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "Elite Yacht Club Membership NFT",
      description: "Enjoy top-tier club membership benefits, limited to 100 units",
      image: "/assets/nfts/yacht-club.png",
      totalSupply: 100,
      price: 0,
      validityPeriod: {
        from: "2025-02-19",
        to: "2026-03-19"
      },
      usageRules: "This NFT is only for the holder to redeem membership benefits. Final interpretation rights belong to the Elite Yacht Club."
    },
    showInExplore: true
  },
  {
    id: 'antarctic-expedition',
    title: "Once-in-a-Lifetime Antarctic Expedition NFT Limited Sale",
    coverImage: "/assets/nfts/antarctic-expedition.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-02-21",
        end: "2026-03-21"
      }
    },
    organizer: {
      name: "Antarctic Expedition",
      avatar: "/assets/logos/antarctic-expedition.jpg"
    },
    status: {
      remaining: 30,
      total: 30,
      note: "Limited to 30 units, while supplies last"
    },
    description: "Experience the ice and snow world of Antarctica with the most creative young people, embarking on a once-in-a-lifetime Antarctic dream journey.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Full-service Antarctic travel experience",
        "Includes flights, hotels, dining, photography and other services",
        "Private aircraft service flying over the Drake Passage"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "Once-in-a-Lifetime Antarctic Expedition NFT",
      description: "Polar expedition, limited to 30 units",
      image: "/assets/nfts/antarctic-expedition.jpg",
      totalSupply: 30,
      price: 0,
      validityPeriod: {
        from: "2025-02-21",
        to: "2026-03-21"
      },
      usageRules: "This NFT is only for the holder to redeem the Antarctic travel package. Final interpretation rights belong to the organizer."
    },
    showInExplore: true
  },
  {
    id: 'peru-spiritual-journey',
    title: "Once-in-a-Lifetime Peru Spiritual Journey NFT Limited Sale",
    coverImage: "/assets/nfts/peru-spiritual.png",
    basicInfo: {
      type: ActivityType.REDEMPTION,
      duration: {
        start: "2025-03-01",
        end: "2026-03-15"
      }
    },
    organizer: {
      name: "Spiritual Journey",
      avatar: "/assets/logos/spiritual-journey.png"
    },
    status: {
      remaining: 20,
      total: 20,
      note: "Limited to 20 units"
    },
    description: "Explore Peru and embark on a mind-altering spiritual journey, experiencing the mysterious power of pristine nature.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Full-service Peru spiritual journey",
        "Includes flights, hotels, dining, photography and other services",
        "Deep experience of local culture and spiritual programs"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "Once-in-a-Lifetime Peru Spiritual Journey NFT",
      description: "Mysterious spiritual journey, limited to 20 units",
      image: "/assets/nfts/peru-spiritual.png",
      totalSupply: 20,
      price: 0,
      validityPeriod: {
        from: "2025-03-01",
        to: "2026-03-15"
      },
      usageRules: "This NFT is only for the holder to redeem the Peru spiritual journey. Final interpretation rights belong to the organizer."
    },
    showInExplore: true
  },
  {
    id: 'burning-man-festival',
    title: "Burning Man Festival NFT Limited Sale",
    coverImage: "/assets/nfts/burning-man.png",
    basicInfo: {
      type: ActivityType.REDEMPTION,
      duration: {
        start: "2025-03-01",
        end: "2026-08-07"
      }
    },
    organizer: {
      name: "Burning Man Official",
      avatar: "/assets/logos/burning-man.png"
    },
    status: {
      remaining: 30,
      total: 30,
      note: "Limited to 30 units"
    },
    description: "Head to Burning Man and fully express yourself in a world of freedom and creativity.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Full-service Burning Man travel experience",
        "Includes flights, hotels, dining, photography and other services",
        "Provides all necessary supplies for Burning Man"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "Burning Man Festival NFT",
      description: "A feast of freedom and creativity, limited to 30 units",
      image: "/assets/nfts/burning-man.png",
      totalSupply: 30,
      price: 0,
      validityPeriod: {
        from: "2025-03-01",
        to: "2026-08-07"
      },
      usageRules: "This NFT is only for the holder to redeem the Burning Man VIP experience. Final interpretation rights belong to the organizer."
    },
    showInExplore: true
  },
  {
    id: '25burger-hangzhou',
    title: "25BURGER City Explorer Membership NFT Limited Sale",
    coverImage: "/assets/nfts/25burger.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-02-21",
        end: "2026-03-21"
      }
    },
    organizer: {
      name: "25BURGER",
      avatar: "/assets/logos/25burger.jpg"
    },
    status: {
      remaining: 1000,
      total: 1000,
      note: "Limited to 1000 units"
    },
    description: "25BURGER, China's first trendy burger hall, is located on the Binjiang section of the Zhijiang Scenic Greenway, with exclusive views of the Three Bridges. It's the first stop on Hangzhou's popular check-in route. The distinctive burger hall and café has become a favorite energy replenishment spot for Hangzhou cyclists; its unique afternoon tea + night drinks further create emotional value for urban youth.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "25BURGER member exclusive 10% discount",
        "Two free coffee vouchers monthly",
        "Priority participation in brand activities",
        "Double points on exclusive member days"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "25BURGER Explorer Membership NFT",
      description: "City Explorer Series NFT, limited to 1000 units",
      image: "/assets/nfts/25burger.jpg",
      totalSupply: 1000,
      price: 0,
      validityPeriod: {
        from: "2025-02-21",
        to: "2026-02-20"
      },
      usageRules: "This NFT can be used to redeem membership benefits. Final interpretation rights belong to 25BURGER."
    },
    showInExplore: true
  },
  {
    id: 'jingci-temple-zen',
    title: "Jingci Temple Abbot Zen Meditation NFT Limited Sale",
    coverImage: "/assets/nfts/jingci-temple.png",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-03-19",
        end: "2026-03-27"
      }
    },
    organizer: {
      name: "Jingci Temple",
      avatar: "/assets/logos/jingci-temple.png"
    },
    status: {
      remaining: 50,
      total: 50,
      note: "Limited to 50 units"
    },
    description: "Step into the ancient Jingci Temple by West Lake in Hangzhou, where the lingering bell sounds seem to transcend a thousand years of time, guiding you to embark on a zen meditation journey with the temple's abbot. Within Jingci Temple, ancient trees reach skyward and incense wafts through the air, with every brick and tile telling stories of the past. Here, you can follow in the abbot's footsteps, study the methods of zen meditation, experience inner peace and tranquility in silence, learn to eliminate distractions, and allow your spirit to settle in zen. The abbot will personally explain Buddhist classics to you, impart wisdom of cultivation, and lead you to understand the profound connotations of Buddhist culture and explore the truth of life through copying and reciting scriptures. Participate in morning and evening services, worship and chant together with the monks, experience the monastic life, and let your body and mind be cleansed in this solemn atmosphere. In the temple courtyard, listen to the abbot share his philosophy of dealing with the world, comprehend the wisdom of life amidst the fragrance of flowers and the songs of birds, and learn to face all things in the world with an ordinary heart. This is not just a journey, but a spiritual practice, a deep dialogue with yourself, allowing you to find a pure land for your soul amidst the hustle and bustle of the world, and gain inner freedom and peace.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "All meals and accommodation during the meditation period",
        "Dharma instruments needed for meditation",
        "Meditation courses taught by the abbot",
        "Participation in temple morning and evening services",
        "Zen tea ceremony experience"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "Jingci Temple Abbot Zen Meditation NFT",
      description: "Limited to 50 units of meditation experience NFT, including meals, accommodation and dharma instruments during the meditation period",
      image: "/assets/nfts/jingci-temple.png",
      totalSupply: 50,
      price: 0,
      validityPeriod: {
        from: "2025-03-19",
        to: "2026-03-27"
      },
      usageRules: "This NFT is only for the holder's personal use and cannot be transferred."
    },
    showInExplore: true
  },
  {
    id: 'japan-microbiota-transplant',
    title: "Japan Gut Microbiota Transplantation NFT Limited Sale",
    coverImage: "/assets/nfts/japan-microbiota.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-02-21",
        end: "2026-03-21"
      }
    },
    organizer: {
      name: "Japan Advanced Medical",
      avatar: "/assets/logos/japan-medical.jpg"
    },
    status: {
      remaining: 30,
      total: 30,
      note: "Limited to 30 units"
    },
    description: "Japan Gut Microbiota Transplantation Deep Experience Journey. In Japan, where bustling cities intertwine with tranquil countryside, a journey concerning health and exploration is about to begin—the Japan Gut Microbiota Transplantation Experience Journey. Upon arrival in Japan, a professional medical team will conduct a comprehensive health assessment and customize a personalized gut microbiota transplantation plan based on your physical condition. In advanced and clean medical facilities, experience the charm of cutting-edge medical technology, using strictly screened high-quality microbiota to reshape the gut microecology in a safe and reliable way. Beyond the medical experience, the journey will also lead you to appreciate Japan's unique scenery. In the tranquility of Kyoto's ancient temples, contemplate the sedimentation of history; on Tokyo's bustling streets, taste authentic cuisine and experience the fusion of tradition and modernity. Soak in hot springs at the foot of Mount Fuji, soothe body and mind, and let your body recover vitality through natural nourishment. This is not just a medical journey to improve gut health, but an unforgettable trip to deeply appreciate Japanese culture and relax body and mind.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Medical expenses for gut microbiota transplantation",
        "Round-trip meals and accommodation expenses",
        "Full-service professional medical team",
        "Japanese scenic spot tours",
        "Hot spring hotel experience"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "Japan Gut Microbiota Transplantation NFT",
      description: "Limited to 30 units of high-end medical experience NFT, including medical and accommodation expenses",
      image: "/assets/nfts/japan-microbiota.jpg",
      totalSupply: 30,
      price: 0,
      validityPeriod: {
        from: "2025-02-21",
        to: "2026-03-21"
      },
      usageRules: "This NFT is only for the holder's personal use and cannot be transferred."
    },
    showInExplore: true
  },
  {
    id: 'sanya-vip-travel',
    title: "Sanya VIP Travel Membership NFT Limited Sale",
    coverImage: "/assets/nfts/sanya-vip.png",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-02-21",
        end: "2026-02-25"
      }
    },
    organizer: {
      name: "Sanya Luxury Travel Club",
      avatar: "/assets/logos/sanya-luxury.jpg"
    },
    status: {
      remaining: 20,
      total: 20,
      note: "Limited to 20 units"
    },
    description: "Encounter Sanya, Enjoy the Extraordinary. Under the bright sunshine at 18 degrees north latitude, embark on a Sanya VIP journey that belongs only to you. The moment the plane lands, a dedicated flight attendant will greet you with a smile, starting your worry-free journey. Arriving at the private luxury villa, the butler is already waiting, thoughtfully arranging your luggage and introducing all the facilities. Here, every detail exudes luxury, with coconut groves and sea views just outside your window, and the breeze carrying the whispers of the waves. Want to go out to sea and ride the waves? No problem! A luxury yacht is ready, with a handsome captain at the helm and yacht babes accompanying you throughout. Cruise on the boundless sea, or leisurely fish; when tired, enjoy a seafood feast meticulously prepared by the chef while feeling the sea breeze. Love thrilling experiences? Paragliding takes you soaring in the sky, giving you a bird's-eye view of the beautiful coastline; all-terrain vehicles take you through the jungle, releasing your inner adventurous spirit. In Sanya, every moment is carefully attended to, making this journey the most brilliant pearl in your memory, engraving a chapter of island luxury travel that belongs only to you.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "One-stop full butler service",
        "Travel necessities including flights, hotels, dining, photography and other services",
        "Exclusive butler, driver, chef service",
        "Yacht sea trip, yacht babe booking service",
        "All-terrain vehicle, paragliding and other experience projects"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "Sanya VIP Travel Membership NFT",
      description: "Limited to 20 units of luxury experience NFT, enjoy full VIP service",
      image: "/assets/nfts/sanya-vip.png",
      totalSupply: 20,
      price: 0,
      validityPeriod: {
        from: "2025-02-21",
        to: "2026-02-25"
      },
      usageRules: "This NFT is only for the holder's personal use and cannot be transferred."
    },
    showInExplore: true
  },
  {
    id: 'spain-pilgrimage',
    title: "Spain Pilgrimage Journey NFT Limited Sale",
    coverImage: "/assets/nfts/spain-pilgrimage.png",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-03-21",
        end: "2026-03-27"
      }
    },
    organizer: {
      name: "Pilgrimage Journey",
      avatar: "/assets/logos/pilgrimage.webp"
    },
    status: {
      remaining: 20,
      total: 20,
      note: "Limited to 20 units"
    },
    description: "Embark on a Spanish pilgrimage journey, follow the thousand-year-old footsteps of faith, and begin an extraordinary journey that touches the soul. Walking along the ancient Camino de Santiago, beneath your feet are stone-paved roads polished by years, each step seems like a dialogue with history. Pass through quiet and quaint towns, where mottled stone walls tell stories of the past; cross vast and boundless fields, where golden waves of wheat undulate in the wind, like a hymn played by nature. Along the way, walk shoulder to shoulder with pilgrims from all over the world, sharing beliefs and insights with each other. When arriving at the Santiago de Compostela Cathedral, in the solemn and dignified atmosphere, listening to the melodious bell, the fatigue and confusion in the heart instantly dissipate, replaced by unprecedented tranquility and satisfaction. In this pilgrimage journey, not only is there a spiritual baptism, but also the opportunity to appreciate Spain's beautiful scenery and unique culture. Taste authentic cuisine, experience passionate folk customs, and immerse body and soul in this charming land. This is a journey to explore faith and find oneself, and more, it is an experience of deep integration with nature and history. Join us, step onto the Spanish pilgrimage road, and meet a better self.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "One-stop full butler service",
        "Travel necessities including flights, hotels, dining, photography and other services",
        "Professional guide accompaniment throughout",
        "In-depth tour of featured attractions",
        "Authentic food tasting experience"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "Spain Pilgrimage Journey NFT",
      description: "Limited to 20 units of pilgrimage experience NFT, including full board and service",
      image: "/assets/nfts/spain-pilgrimage.png",
      totalSupply: 20,
      price: 0,
      validityPeriod: {
        from: "2025-03-21",
        to: "2026-03-27"
      },
      usageRules: "This NFT is only for the holder's personal use and cannot be transferred."
    },
    showInExplore: true
  },
  {
    id: 'kpop-idol-tour',
    title: "K-pop Girl Group Tour NFT Limited Sale",
    coverImage: "/assets/nfts/kpop-culture.avif",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-03-21",
        end: "2026-03-27"
      }
    },
    organizer: {
      name: "K-pop Culture",
      avatar: "/assets/logos/kpop-culture.avif"
    },
    status: {
      remaining: 20,
      total: 20,
      note: "Limited to 20 units"
    },
    description: "Screaming Alert! Dream Tour with Korean Girl Group Begins. Still screaming for Korean girl groups in front of the screen? Now, you can really get close to them! The super amazing Korean girl group experience tour is here! As soon as you get off the plane, girl group members will greet you with smiles, directly opening an exclusive VIP channel. For the following itinerary, they will accompany you throughout. Shopping in Myeongdong, girl group members instantly become fashion consultants, helping you pick out the most trendy Korean outfits, easily turning you into a street fashion expert. Tired from shopping, together enter a warm Korean restaurant. Girl group members enthusiastically recommend authentic food, from sizzling barbecue to spicy army stew, every bite is the ultimate experience of Korean flavor. As night falls, enter a private cinema, immerse in the world of light and shadow with girl group members, sharing leisurely time. This is not just a fan dream come true, but also an unforgettable journey full of surprises and joy. Limited spots, seize the opportunity quickly, create exclusive memories with your girl group idols!",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "One-stop full butler service",
        "Travel necessities including flights, hotels, dining, etc.",
        "Girl group full accompaniment service",
        "Private customized shopping experience",
        "Exclusive movie time"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "K-pop Girl Group Tour NFT",
      description: "Limited to 20 units of girl group accompaniment NFT, enjoy full VIP service",
      image: "/assets/nfts/kpop-culture.avif",
      totalSupply: 20,
      price: 0,
      validityPeriod: {
        from: "2025-03-21",
        to: "2026-03-27"
      },
      usageRules: "This NFT is only for the holder's personal use and cannot be transferred."
    },
    showInExplore: true
  },
  {
    id: 'deyun-vip',
    title: "Deyun Red Event Hall NFT Limited Sale",
    coverImage: "/assets/nfts/deyun-club.png",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-03-16",
        end: "2026-03-24"
      }
    },
    organizer: {
      name: "Deyun Red Event Hall",
      avatar: "/assets/logos/deyun-club.png"
    },
    status: {
      remaining: 100,
      total: 100,
      note: "Limited to 100 units"
    },
    description: "Holding the Deyun Red Event Hall VIP card, start an exclusive feast of joy! Stepping into the Deyun Red Event Hall, you can enjoy a diverse food experience. From sumptuous meals to exquisite afternoon tea, every bite is full of care. Meals include specialties from various regions, allowing taste buds to travel freely; during afternoon tea, desserts and fragrant tea complement each other, adding color to leisurely time. The leisure and entertainment area is a paradise for relaxing body and mind. Whether it's gathering with friends to sing in the KTV, or holding a lively pool party by the swimming pool, it can meet your social needs. In dynamic music and cool water splashes, release vitality freely. And what's most anticipated is the crosstalk performance. The VIP card gives you the best viewing position, allowing you to experience the humor of Deyun performers up close, immersively appreciate the unique charm of traditional crosstalk, and each performance can make you laugh non-stop. The Deyun Red Event Hall VIP card perfectly combines food, entertainment, and art, creating a comprehensive leisure experience for you, becoming your first choice for leisure time.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Deyun Red Event Hall VIP experience card",
        "Meal and afternoon tea service",
        "Leisure and entertainment facility usage rights",
        "Crosstalk performance VIP seats",
        "Exclusive member activity participation rights"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Event Details",
          url: "Event related link"
        }
      ]
    },
    nft: {
      name: "Deyun Red Event Hall NFT",
      description: "Limited to 100 units of VIP experience NFT, enjoy exclusive member benefits",
      image: "/assets/nfts/deyun-club.png",
      totalSupply: 100,
      price: 0,
      validityPeriod: {
        from: "2025-03-16",
        to: "2026-03-24"
      },
      usageRules: "This NFT is only for the holder's personal use and cannot be transferred."
    },
    showInExplore: true
  },
  {
    id: 'starbucks-odyssey',
    title: "Starbucks Odyssey Membership NFT Limited Sale",
    coverImage: "/assets/nfts/starbucks-odyssey.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-03-01",
        end: "2026-03-31"
      }
    },
    organizer: {
      name: "Starbucks",
      avatar: "https://upload.wikimedia.org/wikipedia/en/thumb/d/d3/Starbucks_Corporation_Logo_2011.svg/800px-Starbucks_Corporation_Logo_2011.svg.png"
    },
    status: {
      remaining: 2000,
      total: 5000,
      note: "Limited to 5000 units"
    },
    description: "Join Starbucks Odyssey and begin your coffee exploration journey! As a pioneer of Starbucks' digital membership program, Odyssey NFT brings you an unprecedented membership experience. Each NFT represents a unique coffee culture imprint, allowing you to collect precious digital art while tasting the mellow flavor. Holding Odyssey NFT, you will enjoy: - Limited store exclusive offers - New product tasting privileges - Coffee master courses - Limited edition merchandise priority purchase - Premium coffee tasting events This is not just a membership identity, but a coffee journey full of mellow memories.",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Starbucks Odyssey NFT membership card",
        "Two free coffee vouchers per month",
        "New product tasting rights",
        "Limited edition merchandise priority purchase",
        "Coffee master course special offer"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Starbucks Odyssey Official Website",
          url: "https://www.starbucks.com/odyssey"
        }
      ]
    },
    nft: {
      name: "Starbucks Odyssey NFT Membership Card",
      description: "Limited to 5000 units, exclusive Starbucks member premium benefits",
      image: "/assets/nfts/starbucks-odyssey.jpg",
      totalSupply: 5000,
      price: 0,
      validityPeriod: {
        from: "2025-03-01",
        to: "2026-02-28"
      },
      usageRules: "This NFT is only for the holder's personal use and cannot be transferred."
    },
    showInExplore: false
  },
  {
    id: 'nike-cryptokicks',
    title: "Nike CryptoKicks Digital Sneakers NFT First Release",
    coverImage: "/assets/nfts/nike-cryptokicks.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-04-01",
        end: "2026-04-30"
      }
    },
    organizer: {
      name: "Nike",
      avatar: "/assets/logos/nike-logo.jpg"
    },
    status: {
      remaining: 5000,
      total: 20000,
      note: "First release limited to 20000 units"
    },
    description: "Nike CryptoKicks, a revolutionary digital sneaker NFT series has now arrived! This is not just a virtual sneaker, but a key to the future sports lifestyle. Each CryptoKicks NFT is a unique piece of art, combining Nike's iconic design elements and cutting-edge digital technology. Exclusive benefits for holders: - Limited physical sneaker redemption rights - Priority purchase for Nike new products - Exclusive designer customization service - Metaverse fashion display space - Limited edition digital collectibles",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "CryptoKicks digital sneaker NFT",
        "Limited physical sneaker redemption voucher",
        "Priority purchase rights for Nike new products",
        "Designer customization service",
        "Metaverse display privileges"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Nike .SWOOSH Official Website",
          url: "https://www.nike.com/swoosh"
        }
      ]
    },
    nft: {
      name: "Nike CryptoKicks NFT",
      description: "First release limited to 20000 units, including digital sneakers and exclusive benefits",
      image: "/assets/nfts/nike-cryptokicks.jpg",
      totalSupply: 20000,
      price: 0,
      validityPeriod: {
        from: "2025-04-01",
        to: "2026-04-30"
      },
      usageRules: "This NFT includes digital benefits and physical redemption rights, see instructions for details."
    },
    showInExplore: false
  },
  {
    id: 'porsche-911',
    title: "Porsche 911 NFT Limited Collector's Edition",
    coverImage: "/assets/nfts/porsche-911-nft.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-05-01",
        end: "2026-05-31"
      }
    },
    organizer: {
      name: "Porsche",
      avatar: "/assets/logos/porsche-logo.png"
    },
    status: {
      remaining: 500,
      total: 2363,
      note: "Globally limited to 2363 units"
    },
    description: "Porsche launches its first 911 series NFT, perfectly combining the elegance of the legendary sports car with digital art. Each NFT is a unique digital artwork, created by Porsche designers, showcasing the classic style of the 911 from different eras. Holders not only own precious digital collectibles but can also enjoy exclusive experiences provided by Porsche. Exclusive benefits for holders: - Porsche Experience Center VIP pass - Limited edition 911 model - Exclusive new car launch event invitation - Porsche Sport Driving Course discount - Exclusive display position in metaverse showroom",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Porsche 911 NFT artwork",
        "Experience Center VIP pass",
        "Limited edition 911 model",
        "New car launch event invitation",
        "Driving course special offer"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Porsche NFT Official Website",
          url: "https://nft.porsche.com"
        }
      ]
    },
    nft: {
      name: "Porsche 911 NFT Collector's Edition",
      description: "Globally limited to 2363 units, exclusive Porsche premium benefits",
      image: "/assets/nfts/porsche-911-nft.jpg",
      totalSupply: 2363,
      price: 0,
      validityPeriod: {
        from: "2025-05-01",
        to: "2026-05-31"
      },
      usageRules: "This NFT is an officially authorized Porsche digital collectible, including physical benefits."
    },
    showInExplore: false
  },
  {
    id: 'fifa-world-cup',
    title: "FIFA World Cup Digital Collection NFT",
    coverImage: "/assets/nfts/fifa-worldcup-nft.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-06-01",
        end: "2026-06-30"
      }
    },
    organizer: {
      name: "FIFA",
      avatar: "/assets/logos/fifa-logo.png"
    },
    status: {
      remaining: 20000,
      total: 50000,
      note: "Limited to 50000 units"
    },
    description: "FIFA World Cup launches its first official digital collection NFT, allowing fans to own eternal World Cup memories. Each NFT records classic moments of the World Cup, from amazing goals to touching celebrations, from star performances to team cooperation, these precious moments will be permanently preserved on the blockchain. Exclusive benefits for holders: - World Cup match ticket priority purchase rights - Exclusive match highlights and behind-the-scenes videos - Star meet-and-greet lottery qualification - Limited edition merchandise - Digital collectible trading platform privileges",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "World Cup classic moments NFT",
        "Match ticket priority purchase",
        "Exclusive match content",
        "Star meet-and-greet opportunity",
        "Limited merchandise priority purchase"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "FIFA+ Collect Official Website",
          url: "https://collect.fifa.com"
        }
      ]
    },
    nft: {
      name: "FIFA World Cup Digital Collection NFT",
      description: "Limited to 50000 units, collecting World Cup classic moments",
      image: "/assets/nfts/fifa-worldcup-nft.jpg",
      totalSupply: 50000,
      price: 0,
      validityPeriod: {
        from: "2025-06-01",
        to: "2026-06-30"
      },
      usageRules: "This NFT is a FIFA officially authorized digital collectible."
    },
    showInExplore: false
  },
  {
    id: 'super-bowl-nft',
    title: "Super Bowl LVIII Digital Ticket NFT",
    coverImage: "/assets/nfts/super-bowl-nft.webp",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-01-01",
        end: "2026-02-11"
      }
    },
    organizer: {
      name: "NFL",
      avatar: "https://static.www.nfl.com/image/upload/v1554321393/league/nvfr7ogywskqrfaiu38m.svg"
    },
    status: {
      remaining: 100000,
      total: 250000,
      note: "Limited to 250000 units"
    },
    description: "Super Bowl LVIII official digital ticket NFT, bringing fans an unprecedented viewing experience. Each NFT ticket is not only a viewing credential but also a permanent digital collectible. Holders can enjoy a series of unique benefits, making your Super Bowl night more memorable. Exclusive benefits for holders: - Priority entry for pre-game star performances - Exclusive venue tour opportunity - Limited edition merchandise - Digital collectible exclusive space - Priority purchase for next year's Super Bowl tickets",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Super Bowl digital ticket NFT",
        "Priority entry for pre-game activities",
        "Venue tour opportunity",
        "Limited edition merchandise",
        "Priority purchase for next year's tickets"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "NFL ALL DAY Official Website",
          url: "https://nflallday.com"
        }
      ]
    },
    nft: {
      name: "Super Bowl LVIII Digital Ticket NFT",
      description: "Limited to 250000 units, including exclusive viewing benefits",
      image: "/assets/nfts/super-bowl-nft.webp",
      totalSupply: 250000,
      price: 0,
      validityPeriod: {
        from: "2025-01-01",
        to: "2026-02-11"
      },
      usageRules: "This NFT is an NFL officially authorized digital ticket, including physical viewing benefits."
    },
    showInExplore: false
  },
  {
    id: 'adidas-metaverse',
    title: "Adidas Into the Metaverse NFT",
    coverImage: "/assets/nfts/adidas-metaverse.avif",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-07-01",
        end: "2026-07-31"
      }
    },
    organizer: {
      name: "Adidas",
      avatar: "https://upload.wikimedia.org/wikipedia/commons/2/20/Adidas_Logo.svg"
    },
    status: {
      remaining: 10000,
      total: 30000,
      note: "Limited to 30000 units"
    },
    description: "Adidas' first metaverse series NFT, opening a new era of digital fashion. Into the Metaverse NFT is not just a digital collectible, but also a key to Adidas' metaverse world. Holders can display unique digital equipment in the virtual world and enjoy exclusive benefits in the physical world. Exclusive benefits for holders: - Limited physical apparel redemption rights - VIP invitation to new product launches - Metaverse limited equipment - Digital fashion customization service - Priority purchase at offline pop-up stores",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Metaverse NFT collectible",
        "Limited physical apparel redemption",
        "New product launch invitation",
        "Digital equipment customization",
        "Pop-up store priority purchase"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Adidas Metaverse Official Website",
          url: "https://www.adidas.com/metaverse"
        }
      ]
    },
    nft: {
      name: "Adidas Into the Metaverse NFT",
      description: "Limited to 30000 units, starting a metaverse digital fashion journey",
      image: "/assets/nfts/adidas-metaverse.avif",
      totalSupply: 30000,
      price: 0,
      validityPeriod: {
        from: "2025-07-01",
        to: "2026-07-31"
      },
      usageRules: "This NFT is an Adidas officially authorized digital collectible, including virtual and physical benefits."
    },
    showInExplore: false
  },
  {
    id: 'coca-cola-friendship',
    title: "Coca-Cola Friendship Day Limited NFT",
    coverImage: "/assets/nfts/coca-cola-nft.webp",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-07-01",
        end: "2026-07-31"
      }
    },
    organizer: {
      name: "Coca-Cola",
      avatar: "/assets/logos/coca-cola-logo.webp"
    },
    status: {
      remaining: 5000,
      total: 13615,
      note: "Limited to 13615 units"
    },
    description: "Coca-Cola launches its first Friendship Day limited NFT, allowing memories of happiness and friendship to be permanently stored on the blockchain. Each NFT is a unique digital artwork, combining Coca-Cola's iconic design elements and modern art style. Holders not only own precious digital collectibles but can also enjoy exclusive brand experiences. Exclusive benefits for holders: - Limited edition Coca-Cola physical merchandise - Priority participation rights for brand activities - Priority experience for limited edition drinks - Metaverse exclusive outfit - VIP visit to brand story museum",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Friendship Day limited NFT artwork",
        "Limited physical merchandise",
        "Brand activity priority rights",
        "Limited drink experience",
        "Story museum VIP visit"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Coca-Cola NFT Official Website",
          url: "https://www.coca-cola.com/nft"
        }
      ]
    },
    nft: {
      name: "Coca-Cola Friendship Day NFT",
      description: "Limited to 13615 units, exclusive brand benefits",
      image: "/assets/nfts/coca-cola-nft.webp",
      totalSupply: 13615,
      price: 0,
      validityPeriod: {
        from: "2025-07-01",
        to: "2026-07-31"
      },
      usageRules: "This NFT is a Coca-Cola officially authorized digital collectible."
    },
    showInExplore: false
  },
  {
    id: 'lv-treasure',
    title: "Louis Vuitton VIA Digital Treasure Chest NFT",
    coverImage: "/assets/nfts/lv-treasure-nft.webp",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-08-01",
        end: "2026-08-31"
      }
    },
    organizer: {
      name: "Louis Vuitton",
      avatar: "/assets/logos/lv-logo.png"
    },
    status: {
      remaining: 100,
      total: 500,
      note: "Limited to 500 units"
    },
    description: "Louis Vuitton VIA digital treasure chest NFT, opening a new era of luxury digital art. Each NFT is a unique digital artwork, carefully crafted by LV designers. Holders can display exclusive treasure chests in the virtual world and enjoy noble benefits in the physical world. Exclusive benefits for holders: - Limited edition LV physical product redemption rights - VIP invitation to new product launches - Private customization service - Priority visit to brand exhibitions - Exclusive display space in the metaverse",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "VIA digital treasure chest NFT",
        "Limited physical product redemption",
        "New product launch invitation",
        "Private customization service",
        "Exhibition priority visit"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Louis Vuitton VIA Official Website",
          url: "https://www.louisvuitton.com/via"
        }
      ]
    },
    nft: {
      name: "Louis Vuitton VIA Digital Treasure Chest NFT",
      description: "Limited to 500 units, enjoy exclusive LV benefits",
      image: "/assets/nfts/lv-treasure-nft.webp",
      totalSupply: 500,
      price: 0,
      validityPeriod: {
        from: "2025-08-01",
        to: "2026-08-31"
      },
      usageRules: "This NFT is a Louis Vuitton officially authorized digital collectible."
    },
    showInExplore: false
  },
  {
    id: 'gucci-grail',
    title: "Gucci Grail Digital Fashion NFT",
    coverImage: "/assets/nfts/gucci-grail-nft.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-09-01",
        end: "2026-09-30"
      }
    },
    organizer: {
      name: "Gucci",
      avatar: "/assets/logos/gucci-logo.png"
    },
    status: {
      remaining: 200,
      total: 1000,
      note: "Limited to 1000 units"
    },
    description: "Gucci Grail digital fashion NFT, leading metaverse fashion trends. Each NFT is a unique digital fashion artwork, created by Gucci's design team. Holders can display exclusive fashion in the virtual world and enjoy luxury experiences in the physical world. Exclusive benefits for holders: - Limited edition Gucci physical products - VIP invitation to fashion shows - Digital fashion customization service - Priority visit to brand exhibitions - Metaverse fashion display",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Grail digital fashion NFT",
        "Limited physical products",
        "Fashion show VIP invitation",
        "Digital fashion customization",
        "Exhibition priority visit"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Gucci Vault Official Website",
          url: "https://vault.gucci.com"
        }
      ]
    },
    nft: {
      name: "Gucci Grail Digital Fashion NFT",
      description: "Limited to 1000 units, leading metaverse fashion",
      image: "/assets/nfts/gucci-grail-nft.jpg",
      totalSupply: 1000,
      price: 0,
      validityPeriod: {
        from: "2025-09-01",
        to: "2026-09-30"
      },
      usageRules: "This NFT is a Gucci officially authorized digital collectible."
    },
    showInExplore: false
  },
  {
    id: 'mercedes-nxt',
    title: "Mercedes NXT Digital Art NFT",
    coverImage: "/assets/nfts/mercedes-nxt-nft.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-10-01",
        end: "2026-10-31"
      }
    },
    organizer: {
      name: "Mercedes-Benz",
      avatar: "/assets/logos/mercedes-logo.png"
    },
    status: {
      remaining: 300,
      total: 1000,
      note: "Limited to 1000 units"
    },
    description: "Mercedes NXT digital art NFT, combining automotive craftsmanship and digital art. Each NFT is a unique digital artwork, carefully created by artist Harm van den Dorpel. Holders not only own precious digital artwork but can also enjoy exclusive Mercedes brand experiences. Exclusive benefits for holders: - VIP invitation to new car launches - Brand experience center visit - Limited edition merchandise - Digital art display space - Priority rights for driving experience activities",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "NXT digital art NFT",
        "New car launch invitation",
        "Experience center visit",
        "Limited edition merchandise",
        "Driving experience priority rights"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Mercedes NXT Official Website",
          url: "https://nxt.mercedes-benz.com"
        }
      ]
    },
    nft: {
      name: "Mercedes NXT Digital Art NFT",
      description: "Limited to 1000 units, combining art and technology",
      image: "/assets/nfts/mercedes-nxt-nft.jpg",
      totalSupply: 1000,
      price: 0,
      validityPeriod: {
        from: "2025-10-01",
        to: "2026-10-31"
      },
      usageRules: "This NFT is a Mercedes officially authorized digital collectible."
    },
    showInExplore: false
  },
  {
    id: 'pepsi-mic-drop',
    title: "Pepsi Mic Drop NFT",
    coverImage: "/assets/nfts/pepsi-mic-drop.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-11-01",
        end: "2026-11-30"
      }
    },
    organizer: {
      name: "Pepsi",
      avatar: "/assets/logos/pepsi-logo.jpg"
    },
    status: {
      remaining: 500,
      total: 1893,
      note: "Limited to 1893 units"
    },
    description: "Pepsi launches Mic Drop music-themed NFT, paying tribute to the brand's establishment in 1893. Each NFT is a unique digital microphone artwork, combining music culture and Pepsi's brand spirit. Holders can enjoy exclusive music experiences and brand benefits. Exclusive benefits for holders: - Limited edition Pepsi merchandise - VIP tickets to music festivals - Artist meet-and-greet opportunities - Priority experience for limited drinks - Priority participation in brand activities",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Mic Drop music NFT",
        "Limited merchandise",
        "Music festival VIP tickets",
        "Artist meet-and-greet",
        "Brand activity priority rights"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Pepsi Mic Drop Official Website",
          url: "https://micdrop.pepsi.com"
        }
      ]
    },
    nft: {
      name: "Pepsi Mic Drop NFT",
      description: "Limited to 1893 units, paying tribute to the brand's birth year",
      image: "/assets/nfts/pepsi-mic-drop.jpg",
      totalSupply: 1893,
      price: 0,
      validityPeriod: {
        from: "2025-11-01",
        to: "2026-11-30"
      },
      usageRules: "This NFT is a Pepsi officially authorized digital collectible."
    },
    showInExplore: false
  },
  {
    id: 'mcdonalds-mcrib',
    title: "McDonald's McRib NFT Limited Collection",
    coverImage: "/assets/nfts/mcdonalds-mcrib.webp",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-11-15",
        end: "2026-12-15"
      }
    },
    organizer: {
      name: "McDonald's",
      avatar: "/assets/logos/mcdonalds-logo.png"
    },
    status: {
      remaining: 2,
      total: 10,
      note: "Ultra-rare limited to 10 units"
    },
    description: "McDonald's launches its first ultra-rare McRib NFT, commemorating the return of the classic food. Each NFT is a unique digital artwork, perfectly presenting the iconic shape of McRib. Holders can enjoy exclusive food experiences and brand benefits. Exclusive benefits for holders: - One year free McRib supply - Priority tasting of McDonald's new products - VIP membership card - Limited edition merchandise package - Special guest at brand activities",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "McRib digital collection NFT",
        "One year free supply",
        "Priority tasting of new products",
        "VIP membership benefits",
        "Limited edition merchandise package"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "McDonald's NFT Official Website",
          url: "https://www.mcdonalds.com/nft"
        }
      ]
    },
    nft: {
      name: "McDonald's McRib NFT",
      description: "Ultra-rare limited to 10 units, exclusive food privileges",
      image: "/assets/nfts/mcdonalds-mcrib.webp",
      totalSupply: 10,
      price: 0,
      validityPeriod: {
        from: "2025-11-15",
        to: "2026-12-14"
      },
      usageRules: "This NFT is a McDonald's officially authorized digital collectible."
    },
    showInExplore: false
  },
  {
    id: 'bmw-loyalty',
    title: "BMW Web3 Membership NFT",
    coverImage: "/assets/nfts/bmw-loyalty.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2025-12-01",
        end: "2026-12-31"
      }
    },
    organizer: {
      name: "BMW",
      avatar: "/assets/logos/bmw-logo.png"
    },
    status: {
      remaining: 3000,
      total: 10000,
      note: "Limited to 10000 units"
    },
    description: "BMW launches its first Web3 membership NFT, opening a new era of digital owner services. Each NFT is a unique digital membership credential, providing exclusive services and benefits for owners. Holders can enjoy a comprehensive brand experience. Exclusive benefits for holders: - VIP invitation to new car launches - Exclusive customization service discount - Track experience activity quota - Reservation rights for limited edition models - Digital owner club privileges",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Web3 membership NFT",
        "New car launch invitation",
        "Customization service discount",
        "Track experience quota",
        "Limited model reservation rights"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "BMW Web3 Official Website",
          url: "https://www.bmw.com/web3"
        }
      ]
    },
    nft: {
      name: "BMW Web3 Membership NFT",
      description: "Limited to 10000 units, enjoy owner privileges",
      image: "/assets/nfts/bmw-loyalty.jpg",
      totalSupply: 10000,
      price: 0,
      validityPeriod: {
        from: "2025-12-01",
        to: "2026-12-30"
      },
      usageRules: "This NFT is a BMW officially authorized digital membership credential."
    },
    showInExplore: false
  },
  {
    id: 'rolex-digital',
    title: "Rolex Digital Certification NFT",
    coverImage: "/assets/nfts/rolex-digital.jpg",
    basicInfo: {
      type: ActivityType.MEMBERSHIP,
      duration: {
        start: "2026-01-01",
        end: "2026-01-31"
      }
    },
    organizer: {
      name: "Rolex",
      avatar: "/assets/logos/rolex-logo.jpg"
    },
    status: {
      remaining: 1000,
      total: 5000,
      note: "Limited to 5000 units"
    },
    description: "Rolex launches innovative digital certification NFT, providing blockchain anti-counterfeiting proof for luxury watches. Each NFT is a unique digital certificate, recording complete information and history of the watch. Holders can enjoy exclusive brand services. Exclusive benefits for holders: - Watch authenticity certification service - Priority appointment for maintenance and repair - Invitation to new product launches - VIP showroom visit - Reservation rights for limited editions",
    equity: {
      title: "EQUITY & BENEFITS",
      details: [
        "Digital certification NFT",
        "Authenticity certification service",
        "Priority appointment for maintenance",
        "New product launch invitation",
        "Limited edition reservation rights"
      ]
    },
    externalLinks: {
      title: "EXTERNAL LINKS",
      links: [
        {
          name: "Rolex Digital Official Website",
          url: "https://www.rolex.com/digital"
        }
      ]
    },
    nft: {
      name: "Rolex Digital Certification NFT",
      description: "Limited to 5000 units, enjoy luxury services",
      image: "/assets/nfts/rolex-digital.jpg",
      totalSupply: 5000,
      price: 0,
      validityPeriod: {
        from: "2026-01-01",
        to: "2026-01-31"
      },
      usageRules: "This NFT is a Rolex officially authorized digital certification credential."
    },
    showInExplore: false
  }
];

/**
 * 格式化活动数据
 */
function formatActivityData(data) {
  // 设置默认值
  data.tokenStandard = data.nft.tokenStandard || 'ERC721'; // 默认使用 ERC721 标准

  // 从 basicInfo.duration 提取开始和结束日期
  if (data.basicInfo && data.basicInfo.duration) {
    data.startDate = new Date(data.basicInfo.duration.start);
    data.endDate = new Date(data.basicInfo.duration.end);
  }

  // 确保 externalLinks 是 JSON 字符串
  if (data.externalLinks && typeof data.externalLinks !== 'string') {
    data.externalLinks = JSON.stringify(data.externalLinks);
  }
  
  // 确保 bidStrategy 是 JSON 字符串
  if (data.bidStrategy && typeof data.bidStrategy !== 'string') {
    data.bidStrategy = JSON.stringify(data.bidStrategy);
  }
  
  // 处理区块链相关字段
  if (data.nft && data.nft.contractAddress) {
    data.contractAddress = data.nft.contractAddress;
    data.chainId = data.nft.chainId || 1; // 默认使用以太坊主网
  }

  // 从 NFT 数据中提取相关字段
  if (data.nft) {
    data.nftName = data.nft.name;
    data.nftDescription = data.nft.description;
    data.nftImage = data.nft.image;
    data.nftTotalSupply = data.nft.totalSupply;
    data.nftPrice = data.nft.price;
    data.nftValidityStart = new Date(data.nft.validityPeriod.from);
    data.nftValidityEnd = new Date(data.nft.validityPeriod.to);
    data.nftUsageRules = data.nft.usageRules;
  }

  // 处理状态字段
  if (data.status) {
    data.remaining = data.status.remaining;
    data.total = data.status.total;
    data.statusNote = data.status.note;
  }

  // 确保 remaining 和 total 字段存在且为数字
  if (typeof data.remaining !== 'number') {
    data.remaining = data.total || 0;
  }
  if (typeof data.total !== 'number') {
    data.total = data.remaining || 0;
  }

  // 处理权益字段
  if (data.equity) {
    data.equityTitle = data.equity.title;
    data.equityDetails = data.equity.details;
  }

  // 处理外部链接字段
  if (data.externalLinks) {
    const links = JSON.parse(data.externalLinks);
    data.externalLinksTitle = links.title;
  }

  // 处理图片字段
  if (data.coverImage) {
    data.image = data.coverImage;
  }
  
  // 移除不需要的字段
  const { claimed, basicInfo, nft, organizer, coverImage, status, equity, ...formattedData } = data;

  return formattedData;
}

/**
 * 确保角色存在
 */
async function ensureRolesExist() {
  console.log("Ensuring required roles exist...");
  
  // 简化角色定义
  const requiredRoles = [
    { name: "ADMIN", description: "System administrator" },
    { name: "USER", description: "Regular user" }
    // 移除 ORGANIZATION_ADMIN 角色
  ];
  
  // 创建角色（如果不存在）
  for (const roleData of requiredRoles) {
    const existingRole = await prisma.role.findFirst({
      where: { name: roleData.name }
    });
    
    if (!existingRole) {
      await prisma.role.create({
        data: roleData
      });
      console.log(`Created role: ${roleData.name}`);
    } else {
      console.log(`Role already exists: ${roleData.name}`);
    }
  }
  
  console.log("Role check completed");
}

/**
 * 创建活动及关联组织
 */
async function createActivity(activityData) {
  try {
    const organizerName = activityData.organizer.name;
    
    // 查找组织用户，如果不存在则创建
    const orgEmail = `${organizerName.toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')}@organization.com`;
    
    let orgUser = await prisma.user.findFirst({
      where: { 
        email: orgEmail,
        isOrganization: true
      }
    });
    
    if (!orgUser) {
      console.log(`Creating organization user: ${organizerName}`);
      const hashedPassword = await bcrypt.hash("Org@123", 10);
      
      // 创建组织用户
      orgUser = await prisma.user.create({
        data: {
          email: orgEmail,
          name: organizerName,
          password: hashedPassword,
          isOrganization: true,
          description: `Official organization for ${organizerName}`,
          logo: activityData.organizer.avatar,
          avatar: activityData.organizer.avatar,
          referralCode: generateReferralCode()
        }
      });
      
      // 创建用户角色关联 - 分配 USER 角色而不是 ORGANIZATION_ADMIN
      try {
        // 查找 USER 角色
        const userRole = await prisma.role.findFirst({
          where: { name: "USER" }
        });
        
        if (userRole) {
          // 创建用户角色关联
          await prisma.userRole.create({
            data: {
              user: { connect: { id: orgUser.id } },
              role: { connect: { id: userRole.id } }
            }
          });
          console.log(`Assigned USER role to organization user: ${orgUser.email}`);
        } else {
          console.log("Warning: USER role not found");
        }
      } catch (roleError) {
        console.error("Error assigning role to user:", roleError);
        // 继续执行，不中断脚本
      }
      
      console.log(`Created organization user: ${organizerName}`);
    }
    
    // 检查活动是否已存在
    const existingActivity = await prisma.activity.findUnique({
      where: { id: activityData.id }
    });
    
    if (existingActivity) {
      console.log(`Activity ${activityData.title} already exists, skipping...`);
      return { created: false };
    }
    
    // 格式化活动数据
    const formattedData = formatActivityData(activityData);
    
    // 创建活动并关联组织用户作为创建者
    const activity = await prisma.activity.create({
      data: {
        ...formattedData,
        creator: {
          connect: { id: orgUser.id }
        }
      }
    });
    
    console.log(`Created activity: ${activity.title}`);
    return { created: true, activity };
    
  } catch (error) {
    console.error(`Error creating activity ${activityData.title}:`, error);
    return { created: false, error };
  }
}

/**
 * 创建所有活动
 */
async function createAllActivities() {
  try {
    // 确保角色存在
    await ensureRolesExist();
    
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    for (const activity of activities) {
      const result = await createActivity(activity);
      
      if (result.error) {
        errorCount++;
      } else if (result.created) {
        createdCount++;
      } else {
        skippedCount++;
      }
    }
    
    console.log(`\nActivity creation complete!`);
    console.log(`Created: ${createdCount} activities`);
    console.log(`Skipped: ${skippedCount} activities (already exist)`);
    console.log(`Errors: ${errorCount} activities`);
    console.log(`Total processed: ${activities.length}`);
    
  } catch (error) {
    console.error('Error creating activities:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行脚本
createAllActivities()
  .then(() => console.log('Script completed successfully'))
  .catch(error => console.error('Script failed:', error));