package com.gsuleimanov.sample.repo;

import com.gsuleimanov.sample.domain.Profile;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProfileRepository extends JpaRepository<Profile, Long> {
}
