const axios = require('axios');

// Your API key
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiJkYzM3NDRjZC1iODMzLTQyZGUtYTU3MC01MmJkZjhhNjY5ZmMiLCJzdWIiOiJBUElLZXkiLCJpYXQiOjE3ODI0OTMzNTB9.AdQ8_M2uM5ru2mm1AwofW8rwnXq0V2NBqLdPV-soiZI';

const GRAPHQL_URL = 'https://stashdb.org/graphql';

const HEADERS = {
  'Content-Type': 'application/json',
  'ApiKey': API_KEY
};

// GraphQL client - kept for future data fetching
async function gql(query, variables = {}) {
  try {
    const response = await axios.post(GRAPHQL_URL, {
      query,
      variables
    }, {
      headers: HEADERS
    });

    if (response.data.errors) {
      console.error('GraphQL Errors:', response.data.errors);
      throw new Error('GraphQL Error');
    }

    return response.data.data;
  } catch (error) {
    if (error.response) {
      console.error('API Error:', error.response.status);
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

// Search performer - kept for future updates
async function searchPerformers(term) {
  const query = `
  query SearchPerformer($term: String!) {
    searchPerformer(term: $term) {
      id
      name
      images {
        url
      }
      gender
      scene_count
      is_favorite
    }
  }`;

  const data = await gql(query, { term });
  return data.searchPerformer || [];
}

// Get performer details - kept for future updates
async function getPerformerDetails(performerId) {
  const query = `
  query PerformerDetails($id: ID!) {
    findPerformer(id: $id) {
      id
      name
      images {
        url
      }
      gender
      age
      height
      scene_count
      aliases
      country
      ethnicity
      is_favorite
    }
  }`;

  const data = await gql(query, { id: performerId });
  return data.findPerformer;
}

module.exports = {
  searchPerformers,
  getPerformerDetails,
  gql
};