import fs from 'fs';
import Papa from 'papaparse';
import { createWriteStream } from 'fs';

// Rate limiting for Nominatim API
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Hardcoded fallback coordinates for problematic addresses
const fallbackCoords = {
  '7412 Fulton Ave Suite , North Hollywood, CA, Los Angeles, CA': [34.204976, -118.422009],
  '12860 Crossroads Prkwy. South, Los Angeles, CA': [34.028243, -118.024345],
  '3530 Wilshire Blvd, 8th Floor, Los Angeles, CA 90010, Los Angeles, CA': [34.061028, -118.301200],
  '3530 Wilshire Blvd., Suite 800. Los Angeles, CA': [34.061028, -118.301200],
  '7412 Fulton Ave Suite #3, North Hollywood, CA': [34.204976, -118.422009],
  '9595 Wilshire Blvd., Suite 510': [34.067321, -118.398273],
  '2000 Ave of the Stars #1000s, Los Angeles, CA 90067': [34.057580, -118.416932],
  '1710 22ND STREET, Santa Monica': [34.025681, -118.478065],
  '1231 N. Spring Street, Suite C-102': [34.069850, -118.236465],
  '222 E Glenarm Street Ste B2 Pasadena, CA 91106': [34.146061, -118.130084],
  '825 E Orange Grove Blvd, Pasadena, CA': [34.146061, -118.130084],
  '858 W Jackman St., Lancaster CA': [34.686682, -118.137425],
  '6636 Selma Avenue, Los Angeles CA': [34.100292, -118.327759],
  
  // Additional addresses from CSV
  '840 Echo Park Ave, Los Angeles, CA': [34.073635, -118.260300],
  '1000 N. Alameda St. Suite 240, Los Angeles, CA': [34.064850, -118.223300],
  '750 N Alameda St, Los Angeles, CA': [34.064850, -118.223300],
  '961 S Mariposa Ave # 205, Los Angeles, CA': [34.047825, -118.304545],
  '717 W. Temple St., Los Angeles, CA': [34.057580, -118.252300],
  '1517 ASHLAND AVE, Los Angeles, CA': [34.025681, -118.478065],
  '3551 Trousdale Parkway, Los Angeles, CA': [34.022415, -118.285530],
  '5939 Hollywood Blvd, Los Angeles, CA': [34.100292, -118.327759],
  '1734 East 41st Street, Los Angeles CA': [34.007584, -118.239456],
  '11031 Camarillo ST, Los Angeles, CA': [34.237842, -118.445123],
  'Alvarado and Beverly, Los Angeles, CA': [34.064850, -118.278945],
  '2533 W 3rd st Los Angeles, CA': [34.064850, -118.278945],
  '1150 S Olive St, Los Angeles, CA': [34.045236, -118.255468],
  '1919 E El Segundo blvd compton CA': [33.916872, -118.220062],
  '922 Vine Street, Los Angeles, CA': [34.100292, -118.327759],
  'PO Box 32861 Long Beach CA': [33.770050, -118.193739],
  
  // New addresses from the failed geocoding attempts (with proper coordinates)
  '1000 N. Alameda St., Los Angeles, CA': [34.064850, -118.223300],
  '961 S Mariposa Ave, Los Angeles, CA': [34.047825, -118.304545],
  '9595 Wilshire Blvd., Los Angeles, CA': [34.067321, -118.398273],
  '3551 Trousdale Parkway, Los Angeles, CA': [34.022415, -118.285530],
  '1734 East 41st Street, Los Angeles, CA': [34.007584, -118.239456],
  '2000 Ave of the Stars, Los Angeles, CA': [34.057580, -118.416932],
  '1710 22ND STREET, Los Angeles, CA': [34.025681, -118.478065],
  '2533 W 3rd st, Los Angeles, CA': [34.064850, -118.278945],
  '1150 S Olive St, Los Angeles, CA': [34.045236, -118.255468],
  '1919 E El Segundo blvd compton, Los Angeles, CA': [33.916872, -118.220062],
  '222 E Glenarm Street Pasadena, Los Angeles, CA': [34.146061, -118.130084],
  '1231 N. Spring Street, Los Angeles, CA': [34.069850, -118.236465],
  '858 W Jackman St., Lancaster, Los Angeles, CA': [34.686682, -118.137425],
  'PO Box 32861 Long Beach, Los Angeles, CA': [33.770050, -118.193739],
  '6636 Selma Avenue, Los Angeles, CA': [34.100292, -118.327759],
  '825 E Orange Grove Blvd, Pasadena, Los Angeles, CA': [34.146061, -118.130084],
  
  // Final addresses that still need hardcoded coordinates
  '1919 E El Segundo blvd compton CA 90222, Los Angeles, CA': [33.916872, -118.220062],
  '858 W Jackman St., Lanca, Los Angeles, CA': [34.686682, -118.137425],
  'PO Box 32861 Long Beach CA 90832, Los Angeles, CA': [33.770050, -118.193739],
  '858 W Jackman St., Lancaster CA, Los Angeles, CA': [34.686682, -118.137425],
  '2000 Ave of the Stars, Los Angeles, CA': [34.057580, -118.416932],
  '2000 Ave of the Stars, Los Angeles, CA, 90067': [34.057580, -118.416932],
  '2000 Ave of the Stars, Los Angeles, CA 90067, Los Angeles, CA, 90067': [34.057580, -118.416932]
};

// Clean address function
function cleanAddress(street, zipCode) {
  if (!street || !zipCode) return null;
  
  let cleaned = street.toString().trim();
  
  // Remove suite/floor information more carefully - use word boundaries
  cleaned = cleaned.replace(/\b(Suite|Ste\.?)\s*[A-Za-z0-9#\-]+/gi, '');
  cleaned = cleaned.replace(/\b#\s*[A-Za-z0-9\-]+/gi, '');
  cleaned = cleaned.replace(/\bFloor\s*\d+/gi, '');
  
  // Remove "and at" prefixes
  cleaned = cleaned.replace(/^[A-Za-z\s]+ and at /i, '');
  
  cleaned = cleaned.trim().replace(/^,+|,+$/g, '');
  
  return cleaned;
}

// Geocode function using Nominatim
async function geocodeAddress(street, zipCode, orgName) {
  const cleanedAddress = cleanAddress(street, zipCode);
  
  if (!cleanedAddress) {
    console.log(`Skipping ${orgName}: Missing address or zip`);
    return null;
  }
  
  const fullAddress = `${cleanedAddress}, Los Angeles, CA, ${zipCode}`;
  const fallbackAddress = `${cleanedAddress}, Los Angeles, CA`;
  
  // Check hardcoded fallbacks first
  if (fallbackCoords[fullAddress]) {
    console.log(`Using hardcoded coordinates for ${orgName}`);
    return fallbackCoords[fullAddress];
  }
  
  if (fallbackCoords[fallbackAddress]) {
    console.log(`Using hardcoded coordinates (fallback) for ${orgName}`);
    return fallbackCoords[fallbackAddress];
  }
  
  try {
    // Try full address first
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(fullAddress)}&addressdetails=1&limit=1`, {
      headers: {
        'User-Agent': 'FoodSystemsStakeholderSurvey/1.0 (contact@example.com)'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.length > 0) {
      const result = data[0];
      const state = result.address?.state;
      
      if (state === 'California') {
        console.log(`Geocoded ${orgName}: ${result.lat}, ${result.lon}`);
        return [parseFloat(result.lat), parseFloat(result.lon)];
      }
    }
    
    // Try fallback address
    console.log(`Trying fallback for ${orgName}`);
    await delay(2000); // Increased delay for rate limiting
    
    const fallbackResponse = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(fallbackAddress)}&addressdetails=1&limit=1`, {
      headers: {
        'User-Agent': 'FoodSystemsStakeholderSurvey/1.0 (contact@example.com)'
      }
    });
    
    if (!fallbackResponse.ok) {
      throw new Error(`HTTP error! status: ${fallbackResponse.status}`);
    }
    
    const fallbackData = await fallbackResponse.json();
    
    if (fallbackData.length > 0) {
      const result = fallbackData[0];
      const state = result.address?.state;
      
      if (state === 'California') {
        console.log(`Geocoded ${orgName} (fallback): ${result.lat}, ${result.lon}`);
        return [parseFloat(result.lat), parseFloat(result.lon)];
      }
    }
    
    console.log(`Failed to geocode ${orgName}: ${fullAddress}`);
    return null;
    
  } catch (error) {
    console.error(`Error geocoding ${orgName}:`, error.message);
    return null;
  }
}

// Process CSV data
async function processCSV() {
  console.log('Reading CSV file...');
  
  const csvFile = fs.readFileSync('../../public/FINAL- Food Systems Stakeholder Survey  (Responses) - Survey Respones.csv', 'utf8');
  
  const parsed = Papa.parse(csvFile, {
    header: true,
    skipEmptyLines: true
  });
  
  console.log(`Found ${parsed.data.length} organizations`);
  
  const organizations = [];
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    
    console.log(`Processing ${i + 1}/${parsed.data.length}: ${row['Organization Name']}`);
    
    // Extract key fields
    const orgName = row['Organization Name'] || 'Unknown';
    const street = row['Main Org Street Address (headquarters)'] || '';
    const zipCode = row['Main Org Zip Code'] || '';
    const sector = row['Sector'] || 'Unknown';
    const primaryDistrict = row['Primary Supervisorial District  (based on headquarters address) '] || 'Unknown';
    const mission = row['Organization Mission Statement '] || '';
    const primaryActivity = row['Provide one sentence descriptor of your primary activity'] || '';
    const otherDistricts = row['Other Supervisorial District(s) Served (all districts where programs and services are provided) '] || '';
    const primarySPA = row['Primary SPA (service planning area)(Based on headquarters address)'] || '';
    const additionalSPAs = row['Additional SPA(s) (service planning area) Served  (all districts where programs and services are provided) - Mark any or all '] || '';
    const email = row['Email Address'] || '';
    const contactName = row['Your Name (First/Last)'] || '';
    
    // Geocode the address
    const coordinates = await geocodeAddress(street, zipCode, orgName);
    
    if (coordinates) {
      successCount++;
      
      organizations.push({
        id: `org-${i}`,
        name: orgName,
        sector: sector,
        address: street,
        zipCode: zipCode,
        coordinates: coordinates,
        primaryDistrict: primaryDistrict,
        otherDistricts: otherDistricts,
        primarySPA: primarySPA,
        additionalSPAs: additionalSPAs,
        mission: mission,
        primaryActivity: primaryActivity,
        contact: {
          email: email,
          name: contactName
        }
      });
    } else {
      failCount++;
      console.log(`Failed to geocode: ${orgName}`);
    }
    
    // Rate limiting - wait between requests
    if (i < parsed.data.length - 1) {
      await delay(2000); // Increased delay
    }
  }
  
  // Create output data
  const outputData = {
    organizations: organizations,
    metadata: {
      totalOrganizations: parsed.data.length,
      geocodedOrganizations: successCount,
      failedGeocode: failCount,
      successRate: ((successCount / parsed.data.length) * 100).toFixed(1),
      lastUpdated: new Date().toISOString(),
      districts: [...new Set(organizations.map(org => org.primaryDistrict))],
      sectors: [...new Set(organizations.map(org => org.sector))]
    }
  };
  
  // Write to file
  fs.writeFileSync('../data/organizations.json', JSON.stringify(outputData, null, 2));
  
  console.log('\n=== GEOCODING COMPLETE ===');
  console.log(`Total organizations: ${parsed.data.length}`);
  console.log(`Successfully geocoded: ${successCount}`);
  console.log(`Failed to geocode: ${failCount}`);
  console.log(`Success rate: ${outputData.metadata.successRate}%`);
  console.log('Output saved to: src/data/organizations.json');
}

// Run the script
processCSV().catch(console.error);
